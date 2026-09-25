// ==UserScript==
// @name         Wormax DNA Farmer
// @namespace    local.wormax.dna
// @version      1.4.0
// @description  Farm DNA and quests, track opponent skills, sprint safely, display intended pickups and route, and replay.
// @match        https://wormax.io/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

// Install in Tampermonkey, log in to Wormax (guest rewards are not credited),
// then press Start in the top-left corner. Keep this tab visible for gameplay.
// Completed quest rewards are claimed automatically while running; temporary
// Premium or artefacts begin their timers when claimed.
// STOP unlocks at 100 length; GHOST at 500. Both are used only when ready.
// Press the same button to pause. Set CONFIG.replay to false for manual matches.
// Site interstitial ads can require closing their visible Close button manually.
// The route ends at the next predicted pickup. A dashed link to a food target
// means the current steering horizon approaches it but does not collect it.
// Stopped opponents remain obstacles. Fresh, observed ghosts are passable only
// while their remaining time exceeds the route horizon plus a safety margin.
// Ghosts first seen already transparent have unknown age and are avoided.
// TURBO chases valuable pickups or clear escapes; paid chases preserve a length
// reserve. Opponent ages are exposed by window.__wormaxDnaBot.status().opponents.
(() => {
  'use strict';

  if (window.__wormaxDnaBot) return;

  const CONFIG = {
    steeringIntervalMs: 100,
    menuIntervalMs: 900,
    questIntervalMs: 2000,
    replay: true, // Exit after death and start the next match.
    worldMargin: 110,
    dangerMargin: 22,
    essenceValue: 150,
    maxFoods: 32,
    predictionStepSeconds: 0.15,
    predictionSteps: 11,
    emergencyStepSeconds: 0.1,
    emergencySteps: 9,
    ghostExpiryMarginMs: 700,
    sprintReserveWeight: 100,
  };
  const state = {
    running: false, status: 'Paused', deaths: 0, lastSnakeId: null, lastAction: 0,
    motion: null, escapeUntil: 0, claimedQuests: 0, questPending: false,
    questRetryAt: 0, questError: false, stopRequestedAt: 0, stopStartedAt: 0,
    stopReleaseAt: 0, ghostRequestedAt: 0, sprintRequestedAt: 0,
  };
  const opponents = new Map();

  const panel = document.createElement('div');
  panel.id = 'wormax-dna-bot';
  Object.assign(panel.style, {
    position: 'fixed', left: '12px', top: '12px', zIndex: '2147483647',
    background: 'rgba(8, 24, 12, .9)', color: '#d9ffd9', padding: '8px 10px',
    border: '1px solid #55a955', borderRadius: '6px', font: '13px Arial, sans-serif',
    maxWidth: '220px', pointerEvents: 'auto',
  });
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = 'Start DNA bot';
  Object.assign(toggle.style, { cursor: 'pointer', marginBottom: '5px' });
  const info = document.createElement('div');
  info.textContent = state.status;
  const claimInfo = document.createElement('div');
  claimInfo.textContent = 'Quest rewards: 0';
  panel.append(toggle, info, claimInfo);
  (document.body || document.documentElement).append(panel);

  const routeCanvas = document.createElement('canvas');
  routeCanvas.id = 'wormax-dna-route';
  Object.assign(routeCanvas.style, {
    position: 'fixed', zIndex: '2147483646', pointerEvents: 'none', display: 'none',
    background: 'transparent',
  });
  (document.body || document.documentElement).append(routeCanvas);
  const routeCtx = routeCanvas.getContext('2d');
  const dashedRoute = [8, 11];
  let routePlan = null;
  const solidRoute = [];
  const routePoints = new Float64Array((CONFIG.predictionSteps + 1) * 2);
  let routeFrame = 0;

  function show(text) {
    if (state.status !== text) {
      state.status = text;
      info.textContent = text;
    }
  }
  function showClaims() {
    claimInfo.textContent = `Quest rewards: ${state.claimedQuests}${state.questError ? ' (retrying)' : ''}`;
  }

  function releaseStop(now) {
    if (!state.stopRequestedAt || now - state.stopReleaseAt < 650) return;
    const game = document.getElementById('SnakeGame')?.contentWindow;
    game?.nescc?.stopUseSkill(game.nescg2.STOP);
    state.stopReleaseAt = now;
  }

  function releaseSprint() {
    if (!state.sprintRequestedAt) return;
    const game = document.getElementById('SnakeGame')?.contentWindow;
    game?.nescc?.stopUseSkill(game.nescg2.TURBO);
    state.sprintRequestedAt = 0;
  }

  function stop(message = 'Paused') {
    state.running = false;
    if (state.stopRequestedAt && !state.stopReleaseAt) releaseStop(Date.now());
    releaseSprint();
    opponents.clear();
    cancelAnimationFrame(routeFrame);
    routePlan = null;
    routeFrame = 0;
    routeCanvas.style.display = 'none';
    state.motion = null;
    state.escapeUntil = 0;
    toggle.textContent = 'Start DNA bot';
    show(message);
  }

  function start() {
    if (state.running) return;
    state.running = true;
    state.lastAction = 0;
    state.motion = null;
    routePlan = null;
    state.escapeUntil = 0;
    opponents.clear();
    toggle.textContent = 'Pause DNA bot';
    show('Waiting for game');
    routeFrame = requestAnimationFrame(drawRoute);
  }

  toggle.addEventListener('click', () => state.running ? stop() : start());
  window.__wormaxDnaBot = Object.freeze({ start, stop, status: () => ({
    ...state,
    opponents: Array.from(opponents, ([id, other]) => ({
      id, stopped: other.stopped, ghost: other.ghost, passable: other.passable,
      ghostAgeMs: other.ghostSince === null ? null : other.seenAt - other.ghostSince,
      ghostObservedMs: other.ghostSeenAt === null ? null : other.seenAt - other.ghostSeenAt,
    })),
  }) });

  function client() {
    const frame = document.getElementById('SnakeGame');
    return frame?.contentWindow?.nesc?.INSTANCE_2 || null;
  }

  function entries(map) {
    const backing = map?.hashCodeMap?.backingMap;
    if (!backing || typeof backing.values !== 'function') {
      throw new Error('Game map layout changed; update the userscript.');
    }
    return backing.values();
  }

  function collectQuestRewards() {
    if (!state.running || state.questPending || Date.now() < state.questRetryAt) return;
    try {
      const game = document.getElementById('SnakeGame')?.contentWindow;
      const profile = game?.nesc?.userProfile_0;
      if (!profile?.questsActive || !profile.quests) return;
      for (const type of game.nescg2.values_46()) {
        const quest = profile.quests.get_14(type);
        if (!quest?.isRewardAvailable(type)) continue;
        const previousLevel = quest.level;
        state.questPending = true;
        game.nesc.portal.takeQuestReward(type).handle_2({
          accept(result) {
            state.questPending = false;
            const level = game.nesc.userProfile_0?.quests?.get_14(type)?.level;
            if (result && level > previousLevel) {
              state.claimedQuests++;
              state.questError = false;
              showClaims();
              state.questRetryAt = Date.now() + 1000;
            } else {
              state.questError = true;
              state.questRetryAt = Date.now() + 30000;
              showClaims();
            }
          },
        }, {
          accept() {
            state.questPending = false;
            state.questError = true;
            state.questRetryAt = Date.now() + 30000;
            showClaims();
            console.warn('[Wormax DNA bot] Quest claim failed; retrying later.');
          },
        });
        return; // One server request at a time, then inspect the refreshed profile.
      }
    } catch {
      state.questPending = false;
      state.questError = true;
      state.questRetryAt = Date.now() + 30000;
      showClaims();
      console.warn('[Wormax DNA bot] Quest claim unavailable; retrying later.');
    }
  }

  function angleDelta(from, to) {
    return Math.atan2(Math.sin(to - from), Math.cos(to - from));
  }

  function distanceToSegment(x, y, line) {
    const dx = line.bx - line.ax;
    const dy = line.by - line.ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1,
      ((x - line.ax) * dx + (y - line.ay) * dy) / lengthSquared)) : 0;
    return Math.hypot(x - line.ax - t * dx, y - line.ay - t * dy);
  }

  function observeOpponent(snake, now, ghostDurationMs) {
    let other = opponents.get(snake.id_0);
    if (!other || other.snake !== snake || now < other.seenAt ||
        now - other.seenAt > CONFIG.steeringIntervalMs * 3) {
      other = { snake, ghost: !!snake.ghost, ghostSince: null,
        ghostSeenAt: snake.ghost ? now : null, seenAt: now };
      opponents.set(snake.id_0, other);
    } else if (!snake.ghost) {
      other.ghostSince = other.ghostSeenAt = null;
    } else if (!other.ghost) {
      // Earliest possible start, not the later time at which we noticed it.
      other.ghostSince = other.seenAt;
      other.ghostSeenAt = now;
    }
    other.seenAt = now;
    other.ghost = !!snake.ghost;
    other.stopped = !!snake.stop_0;
    // Unknown-age ghosts stay solid. Known ghosts must outlast the entire route.
    other.passable = other.ghost && other.ghostSince !== null &&
      ghostDurationMs - (now - other.ghostSince) >
        CONFIG.predictionSteps * CONFIG.predictionStepSeconds * 1000 +
          CONFIG.ghostExpiryMarginMs;
    return other;
  }

  function travelDistance(snake, seconds, turbo = false) {
    const speed = Math.max(0, snake.currentSpeed ?? 120);
    const target = Math.max(0,
      (turbo ? snake.lastTickTurboSpeed : snake.lastTickNormalSpeed) ?? speed);
    const acceleration = snake.lastTickAcceleration;
    if (!(acceleration > 0)) return Math.max(speed, target) * seconds;
    const ramp = Math.min(seconds, Math.abs(target - speed) / acceleration);
    return (speed + Math.sign(target - speed) * acceleration * ramp / 2) * ramp +
      target * (seconds - ramp);
  }

  function readArena(view, snake, now, ghostDurationMs) {
    const px = view.playerSnakeView.x_0;
    const py = view.playerSnakeView.y_0;
    const foods = [];
    const toxins = [];
    const selfRadius = snake.getRadius();
    const turnDiameter = snake.getRotationRadius() * 2 + selfRadius * 2;
    let dnaNearby = 0;
    for (const bucket of entries(view.foodViews)) {
      for (const entry of bucket) {
        const food = entry.value_0;
        const name = food?.skin?.name_1;
        if (!name || food.foodRemoving || food.eatenBy) continue;
        const x = food.x_0, y = food.y_0;
        const distance = Math.hypot(x - px, y - py);
        if (distance > 900) continue;
        if (name.startsWith('TOXIC_')) {
          if (distance < 650) toxins.push({ x, y });
          continue;
        }
        let value;
        if (name === 'BOOSTER_ESSENCE') {
          value = CONFIG.essenceValue;
          dnaNearby++;
        } else if (name.startsWith('FOOD_')) {
          value = Number(name.slice(5)) || 1;
        } else if (name === 'BIG_FOOD') {
          value = 10;
        } else if (food.skin.booster) {
          value = 7;
        } else {
          value = 1;
        }
        // A close pickup behind the head cannot be reached with this turning radius.
        if (distance < turnDiameter &&
            Math.cos(snake.direction_0 - Math.atan2(y - py, x - px)) < -0.5) continue;
        foods.push({ x, y, distance, value, dna: name === 'BOOSTER_ESSENCE' });
      }
    }
    foods.sort((a, b) => b.value / (b.distance + 100) - a.value / (a.distance + 100));
    foods.length = Math.min(foods.length, CONFIG.maxFoods);

    const obstacles = [];
    const heads = [];
    for (const bucket of entries(view.snakes)) {
      for (const entry of bucket) {
        const other = entry.value_0;
        if (!other || other.id_0 === snake.id_0 || other.isDying()) continue;
        if (observeOpponent(other, now, ghostDurationMs).passable) continue;
        const radius = other.getRadius() + selfRadius + CONFIG.dangerMargin;
        const points = other.segments?.array;
        let prev = null;
        for (let i = 0; i < (points?.length || 0); i++) {
          const pos = points[i]?.pos;
          if (!pos) continue;
          const x = pos.x_0, y = pos.y_0;
          if (Math.abs(x - px) < 630 && Math.abs(y - py) < 630) {
            obstacles.push({ ax: x, ay: y, bx: x, by: y, radius });
          }
          if (prev && Math.hypot(x - prev.x_0, y - prev.y_0) < 180 &&
              Math.abs(x - px) < 680 && Math.abs(y - py) < 680) {
            obstacles.push({ ax: prev.x_0, ay: prev.y_0, bx: x, by: y, radius });
          }
          prev = pos;
        }
        const head = other.lastTickPosition;
        if (head && Math.abs(head.x_0 - px) < 680 && Math.abs(head.y_0 - py) < 680) {
          const otherSpeed = other.stop_0 ? 0 : Math.max(0, other.currentSpeed ?? 120);
          heads.push({ x: head.x_0, y: head.y_0, direction: other.direction_0,
            speed: otherSpeed, turnRate: otherSpeed / Math.max(20, other.getRotationRadius()),
            stopped: !!other.stop_0,
            resumeSpeed: Math.max(other.currentSpeed ?? 0,
              (other.turbo ? other.lastTickTurboSpeed : other.lastTickNormalSpeed) ?? 120),
            radius });
        }
      }
    }
    for (const [id, other] of opponents) {
      if (other.seenAt !== now) opponents.delete(id);
    }
    return { px, py, foods, toxins, obstacles, heads, selfRadius, dnaNearby };
  }

  const closestFoodApproach = new Float64Array(CONFIG.maxFoods);
  const pickupArrival = new Float64Array(CONFIG.maxFoods);
  const predictionStrides = new Float64Array(CONFIG.predictionSteps);

  function chooseHeading(arena, snake, worldRadius, escaping, mode = 'normal', turbo = false) {
    const { px, py, toxins, selfRadius } = arena;
    const foods = escaping ? [] : arena.foods;
    const obstacles = mode === 'ghost' ? [] : arena.obstacles;
    const heads = mode === 'ghost' ? [] : arena.heads;
    const current = snake.direction_0;
    const rotationRadius = Math.max(20, snake.getRotationRadius());
    const dt = CONFIG.predictionStepSeconds;
    let distance = 0;
    for (let step = 1; step <= CONFIG.predictionSteps; step++) {
      const next = travelDistance(snake, step * dt, turbo);
      predictionStrides[step - 1] = next - distance;
      distance = next;
    }
    const nearEdge = Math.hypot(px, py) + distance >
      worldRadius - CONFIG.worldMargin - selfRadius - 130;
    const toxinRange = selfRadius + 35;
    const pickupRadius = selfRadius + 8;
    const candidates = [current];
    for (let i = -12; i <= 12; i++) candidates.push(current + i * Math.PI / 12);
    for (const food of foods.slice(0, 5)) {
      const toward = Math.atan2(food.y - py, food.x - px);
      candidates.push(toward, toward - 0.3, toward + 0.3);
    }
    if (Math.hypot(px, py) > worldRadius - 750) candidates.push(Math.atan2(-py, -px));

    let best = current;
    let bestScore = -Infinity;
    let bestDanger = Infinity;
    let bestTarget = null;
    let bestArrival = Infinity;
    for (const desired of candidates) {
      let x = px, y = py, heading = current, danger = 0;
      closestFoodApproach.fill(Infinity, 0, foods.length);
      pickupArrival.fill(Infinity, 0, foods.length);
      for (let step = 1; step <= CONFIG.predictionSteps; step++) {
        const stride = predictionStrides[step - 1];
        const turnStep = stride / rotationRadius;
        const invStrideSquared = stride > 0 ? 1 / (stride * stride) : 0;
        heading += Math.max(-turnStep, Math.min(turnStep, angleDelta(heading, desired)));
        const previousX = x, previousY = y;
        const dx = Math.cos(heading) * stride;
        const dy = Math.sin(heading) * stride;
        x += dx;
        y += dy;
        for (let i = 0; i < foods.length; i++) {
          const food = foods[i];
          const t = Math.max(0, Math.min(1,
            ((food.x - previousX) * dx + (food.y - previousY) * dy) * invStrideSquared));
          const distance = Math.hypot(food.x - previousX - t * dx,
            food.y - previousY - t * dy);
          if (distance < closestFoodApproach[i]) closestFoodApproach[i] = distance;
          if (distance <= pickupRadius && pickupArrival[i] === Infinity)
            pickupArrival[i] = (step - 1 + t) * dt;
        }

        if (nearEdge) {
          const boundary = worldRadius - CONFIG.worldMargin - selfRadius - Math.hypot(x, y);
          if (boundary < 0) danger += 2000;
          else if (boundary < 130) danger += (130 - boundary) / 6;
        }
        for (const line of obstacles) {
          if (Math.abs(line.ax - x) > 250 && Math.abs(line.bx - x) > 250) continue;
          if (Math.abs(line.ay - y) > 250 && Math.abs(line.by - y) > 250) continue;
          const clearance = distanceToSegment(x, y, line) - line.radius;
          if (clearance < 0) danger += 900 + 20 * -clearance;
          else if (clearance < 70) danger += (70 - clearance) ** 2 / 140;
        }
        for (const head of heads) {
          const future = step * dt;
          const hx = head.x + Math.cos(head.direction) * head.speed * future;
          const hy = head.y + Math.sin(head.direction) * head.speed * future;
          const clearance = Math.hypot(x - hx, y - hy) - head.radius - 15;
          if (clearance < 0) danger += 1200;
          else if (clearance < 80) danger += (80 - clearance) ** 2 / 110;
          if (mode === 'cautious') {
            const possible = clearance - headTurnReach(head, future);
            if (possible < 0) danger += 150 - 5 * possible;
            else if (possible < 35) danger += (35 - possible) ** 2 / 10;
          }
        }
        for (const toxin of toxins) {
          if (Math.abs(x - toxin.x) > toxinRange || Math.abs(y - toxin.y) > toxinRange) continue;
          const clearance = Math.hypot(x - toxin.x, y - toxin.y) - selfRadius - 10;
          if (clearance < 0) danger += 35;
          else if (clearance < 25) danger += (25 - clearance) / 2;
        }
      }

      let reward = 0;
      for (let i = 0; i < foods.length; i++) {
        const food = foods[i];
        const arrival = pickupArrival[i];
        let value;
        if (arrival < Infinity) {
          // Prefer early, centered pickups over grazing a target while turning away.
          const centered = Math.min(1, (pickupRadius - closestFoodApproach[i]) /
            (pickupRadius * 0.4));
          value = (0.3 + 0.7 * centered) / (1 + arrival / 0.25);
        } else {
          const approach = Math.max(0, (food.distance - closestFoodApproach[i]) /
            Math.max(1, food.distance - pickupRadius));
          value = 0.15 * approach;
        }
        reward += food.value * 100 / (food.distance + 100) * value;
      }
      // Keep moving into unexplored territory when no pickup is in view.
      const score = reward - danger - 0.6 * Math.abs(angleDelta(current, desired));
      if (score > bestScore) {
        bestScore = score;
        bestDanger = danger;
        best = desired;
        bestTarget = null;
        bestArrival = Infinity;
        let bestApproach = 0;
        for (let i = 0; i < foods.length; i++) {
          const food = foods[i];
          if (pickupArrival[i] < bestArrival) {
            bestArrival = pickupArrival[i];
            bestTarget = food;
          } else if (bestArrival === Infinity) {
            const approach = Math.max(0, (food.distance - closestFoodApproach[i]) /
              Math.max(1, food.distance - pickupRadius));
            const attraction = food.value * approach / (food.distance + 100);
            if (attraction > bestApproach) {
              bestApproach = attraction;
              bestTarget = food;
            }
          }
        }
      }
    }
    return { heading: best, target: bestTarget, arrival: bestArrival,
      danger: bestDanger, mode, turbo };
  }

  function headTurnReach(head, seconds) {
    if (head.stopped) return head.resumeSpeed * seconds;
    return Math.min(75, head.speed * seconds *
      Math.min(1, head.turnRate * seconds * 0.45));
  }

  function assessThreat(arena, snake, desired, stationary = false) {
    const dt = CONFIG.emergencyStepSeconds;
    const rotationRadius = Math.max(20, snake.getRotationRadius());
    let distance = 0;
    let x = arena.px, y = arena.py, heading = snake.direction_0;
    let direct = Infinity, uncertain = Infinity;
    for (let step = 1; step <= CONFIG.emergencySteps; step++) {
      const seconds = step * dt;
      const next = stationary ? 0 : travelDistance(snake, seconds);
      const stride = next - distance;
      distance = next;
      const turnStep = stride / rotationRadius;
      if (!stationary) {
        heading += Math.max(-turnStep, Math.min(turnStep, angleDelta(heading, desired)));
        x += Math.cos(heading) * stride;
        y += Math.sin(heading) * stride;
      }
      for (const line of arena.obstacles) {
        if (Math.abs(line.ax - x) > 200 && Math.abs(line.bx - x) > 200) continue;
        if (Math.abs(line.ay - y) > 200 && Math.abs(line.by - y) > 200) continue;
        if (distanceToSegment(x, y, line) < line.radius) direct = Math.min(direct, seconds);
      }
      for (const head of arena.heads) {
        const hx = head.x + Math.cos(head.direction) * head.speed * seconds;
        const hy = head.y + Math.sin(head.direction) * head.speed * seconds;
        const clearance = Math.hypot(x - hx, y - hy) - head.radius;
        if (clearance < 0) direct = Math.min(direct, seconds);
        if (clearance < headTurnReach(head, seconds))
          uncertain = Math.min(uncertain, seconds);
      }
    }
    return { direct, uncertain };
  }

  function skillButton(view, name) {
    const children = view.hud?.dashboardView?.children;
    for (let i = 0; i < (children?.size_0 || 0); i++) {
      const button = children.items[i];
      if (button?.skill?.name_1 === name) return button;
    }
    return null;
  }

  function skillReady(button, snake, now) {
    const skill = button?.skillState;
    return !!skill && !skill.activated_0 && snake.canUseSkill(button.skill) &&
      skill.usedTime + skill.cooldown < now;
  }

  function planSprint(game, view, arena, snake, radius, plan, escaping) {
    const now = game.nesc.gameTime();
    const button = skillButton(view, 'TURBO');
    const normalSpeed = snake.lastTickNormalSpeed;
    const turboSpeed = snake.lastTickTurboSpeed;
    const acceleration = snake.lastTickAcceleration;
    const free = snake.hasBooster(game.nescgm.BOOSTER_FREE_TURBO);
    const fleeing = escaping || plan.label === 'Evading';
    const brakingDistance = acceleration > 0
      ? Math.max(0, (turboSpeed * turboSpeed - normalSpeed * normalSpeed) / (2 * acceleration))
      : Infinity;
    const pickupDistance = brakingDistance + arena.selfRadius * 2 + 50;
    const target = plan.target;
    const chasing = target && target.distance > pickupDistance &&
      (free || target.dna || target.value >= 7);
    if (snake.stop_0 || plan.label === 'Braking' || plan.label === 'Ghost expiring' ||
        (plan.label === 'Ghosting' && !snake.ghost) ||
        !(turboSpeed > normalSpeed && normalSpeed > 0 && acceleration > 0) ||
        !button || !snake.canUseSkill(button.skill) ||
        (!button.skillState?.activated_0 && !skillReady(button, snake, now)) ||
        (!free && !fleeing &&
          snake.weight <= game.nescg2.i_2().minSnakeWeight + CONFIG.sprintReserveWeight) ||
        (!fleeing && !chasing)) {
      releaseSprint();
      return plan;
    }
    const sprint = chooseHeading(arena, snake, radius, fleeing,
      plan.mode === 'ghost' ? 'ghost' : 'cautious', true);
    // Check the full faster trajectory, not the short, normal-speed safe corridor.
    if (sprint.danger > 0 || Math.abs(angleDelta(snake.direction_0, sprint.heading)) > 0.35 ||
        (!fleeing && (!sprint.target || sprint.target.distance <= pickupDistance ||
          !(free || sprint.target.dna || sprint.target.value >= 7)))) {
      releaseSprint();
      return plan;
    }
    if (!state.sprintRequestedAt ||
        (!snake.turbo && now - state.sprintRequestedAt > 650)) {
      game.nescc.useSkill(snake, button.skill);
      state.sprintRequestedAt = now;
    }
    sprint.label = plan.label === 'Playing' ? 'Sprinting' : `${plan.label} · sprinting`;
    return sprint;
  }

  function emergencyHeading(game, view, arena, snake, radius, escaping) {
    const now = game.nesc.gameTime();
    const stopButton = skillButton(view, 'STOP');
    const ghostButton = skillButton(view, 'GHOST');
    const ghostState = ghostButton?.skillState;
    const ghostSafe = snake.ghost && ghostState?.activated_0 &&
      ghostState.usedTime + ghostState.duration - now >
        CONFIG.predictionStepSeconds * CONFIG.predictionSteps * 1000 + 250;
    let plan = chooseHeading(arena, snake, radius, escaping, ghostSafe ? 'ghost' : 'normal');
    if (snake.ghost) {
      if (snake.stop_0 && state.stopRequestedAt) releaseStop(now);
      plan.label = ghostSafe ? 'Ghosting' : 'Ghost expiring';
      return plan;
    }

    if (snake.stop_0 && !state.stopStartedAt) {
      state.stopStartedAt = now;
      state.motion = null;
    }
    if (!snake.stop_0 && state.stopStartedAt) {
      state.stopRequestedAt = state.stopStartedAt = state.stopReleaseAt = 0;
      state.motion = null;
    }
    const stopPending = state.stopRequestedAt && !state.stopReleaseAt &&
      now - state.stopRequestedAt < 1200;
    if (snake.stop_0 || stopPending) {
      plan = chooseHeading(arena, snake, radius, true, 'cautious');
      const moving = assessThreat(arena, snake, plan.heading);
      const stationary = assessThreat(arena, snake, plan.heading, true);
      const elapsed = now - (state.stopStartedAt || state.stopRequestedAt);
      const exhausted = elapsed >= Math.max(400, (stopButton?.skillState?.duration || 3000) - 550);
      if (skillReady(ghostButton, snake, now) && now - state.ghostRequestedAt > 1100 &&
          (stationary.direct <= 0.3 || stationary.uncertain <= 0.25 ||
            (exhausted && (moving.direct <= 0.9 || moving.uncertain <= 0.55)))) {
        game.nescc.useSkill(snake, ghostButton.skill);
        state.ghostRequestedAt = now;
        releaseStop(now);
        plan.label = 'Ghosting';
        return plan;
      }
      if (snake.stop_0 && ((elapsed > 450 && moving.direct > 0.9 &&
          moving.uncertain > 0.65 && stationary.direct > 0.35) || exhausted))
        releaseStop(now);
      plan.label = 'Braking';
      return plan;
    }

    if (state.ghostRequestedAt && now - state.ghostRequestedAt < 1200) {
      plan.label = 'Ghosting';
      return plan;
    }
    const risk = assessThreat(arena, snake, plan.heading);
    if (risk.direct > 0.9 && risk.uncertain > 0.75) {
      plan.label = escaping ? 'Escaping orbit' : 'Playing';
      return plan;
    }
    plan = chooseHeading(arena, snake, radius, true, 'cautious');
    const escape = assessThreat(arena, snake, plan.heading);
    if (escape.direct > 0.9 && escape.uncertain > 0.7) {
      plan.label = 'Evading';
      return plan;
    }
    const ghostReady = skillReady(ghostButton, snake, now) &&
      now - state.ghostRequestedAt > 1100;
    const stopReady = skillReady(stopButton, snake, now) &&
      now - state.stopRequestedAt > 1100;
    if (ghostReady && (escape.direct <= 0.5 || escape.uncertain <= 0.18 ||
        (!stopReady && escape.uncertain <= 0.55))) {
      game.nescc.useSkill(snake, ghostButton.skill);
      state.ghostRequestedAt = now;
      plan.label = 'Ghosting';
      return plan;
    }
    if (stopReady && (escape.direct <= 0.9 || escape.uncertain <= 0.7)) {
      game.nescc.useSkill(snake, stopButton.skill);
      state.stopRequestedAt = now;
      state.stopStartedAt = state.stopReleaseAt = 0;
      state.motion = null;
      plan.label = 'Braking';
      return plan;
    }
    if (ghostReady && (escape.direct <= 0.9 || escape.uncertain <= 0.55)) {
      game.nescc.useSkill(snake, ghostButton.skill);
      state.ghostRequestedAt = now;
      plan.label = 'Ghosting';
      return plan;
    }
    plan.label = 'Evading';
    return plan;
  }

  function drawRoute() {
    routeFrame = requestAnimationFrame(drawRoute);
    const view = client()?.gameView;
    const player = view?.playerSnakeView;
    const snake = player?.snake;
    const camera = view?.cameraController?.camera;
    const gameCanvas = document.querySelector('canvas:not(#wormax-dna-route)');
    if (!routePlan || !view || view.finished || !snake || snake.isDying() ||
        !player.getParent_0() || state.lastSnakeId !== snake.id_0 ||
        !view.playerSnakeController || !camera?.position_0 || !gameCanvas) {
      if (routeCanvas.style.display !== 'none') routeCanvas.style.display = 'none';
      return;
    }
    const rect = gameCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !camera.viewportWidth ||
        !camera.viewportHeight || !camera.zoom) {
      if (routeCanvas.style.display !== 'none') routeCanvas.style.display = 'none';
      return;
    }

    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.round(rect.width * pixelRatio);
    const height = Math.round(rect.height * pixelRatio);
    if (routeCanvas.width !== width || routeCanvas.height !== height) {
      routeCanvas.width = width;
      routeCanvas.height = height;
      routeCanvas.style.width = `${rect.width}px`;
      routeCanvas.style.height = `${rect.height}px`;
      routeCtx.setTransform(width / rect.width, 0, 0, height / rect.height, 0, 0);
    }
    if (routeCanvas.style.left !== `${rect.left}px`) routeCanvas.style.left = `${rect.left}px`;
    if (routeCanvas.style.top !== `${rect.top}px`) routeCanvas.style.top = `${rect.top}px`;
    routeCtx.clearRect(0, 0, rect.width, rect.height);

    const scaleX = rect.width / (camera.viewportWidth * camera.zoom);
    const scaleY = rect.height / (camera.viewportHeight * camera.zoom);
    const centerX = rect.width / 2 - camera.position_0.x_0 * scaleX;
    const centerY = rect.height / 2 + camera.position_0.y_0 * scaleY;
    const rotationRadius = Math.max(20, snake.getRotationRadius());
    const desired = routePlan.heading;
    const target = routePlan.target;
    const reachable = Number.isFinite(routePlan.arrival);
    let heading = snake.direction_0;
    let x = player.x_0, y = player.y_0;
    let guideIndex = 0;
    let guideDistance = target && !reachable
      ? (target.x - x) ** 2 + (target.y - y) ** 2 : Infinity;
    routePoints[0] = x;
    routePoints[1] = y;
    let lastIndex = 0;
    for (let step = 1; step <= CONFIG.predictionSteps; step++) {
      const startSeconds = (step - 1) * CONFIG.predictionStepSeconds;
      const startDistance = travelDistance(snake, startSeconds, routePlan.turbo);
      const stride = travelDistance(snake, step * CONFIG.predictionStepSeconds,
        routePlan.turbo) - startDistance;
      const turnStep = stride / rotationRadius;
      heading += Math.max(-turnStep, Math.min(turnStep, angleDelta(heading, desired)));
      const fraction = reachable
        ? Math.max(0, Math.min(1,
          (routePlan.arrival - startSeconds) / CONFIG.predictionStepSeconds))
        : 1;
      x += Math.cos(heading) * stride * fraction;
      y += Math.sin(heading) * stride * fraction;
      routePoints[step * 2] = x;
      routePoints[step * 2 + 1] = y;
      lastIndex = step;
      if (target && !reachable) {
        const distance = (target.x - x) ** 2 + (target.y - y) ** 2;
        if (distance < guideDistance) {
          guideDistance = distance;
          guideIndex = step;
        }
      }
      if (reachable && step * CONFIG.predictionStepSeconds >= routePlan.arrival) break;
    }
    routeCtx.beginPath();
    routeCtx.moveTo(centerX + routePoints[0] * scaleX, centerY - routePoints[1] * scaleY);
    const routeEnd = target && !reachable ? guideIndex : lastIndex;
    for (let step = 1; step <= routeEnd; step++)
      routeCtx.lineTo(centerX + routePoints[step * 2] * scaleX,
        centerY - routePoints[step * 2 + 1] * scaleY);
    routeCtx.lineCap = 'round';
    routeCtx.lineJoin = 'round';
    routeCtx.shadowColor = '#32dfff';
    routeCtx.shadowBlur = 18;
    routeCtx.strokeStyle = 'rgba(28, 193, 255, .18)';
    routeCtx.lineWidth = Math.max(30, snake.getRadius() * scaleX * 2);
    routeCtx.stroke();
    routeCtx.shadowBlur = 0;
    routeCtx.strokeStyle = 'rgba(45, 216, 255, .36)';
    routeCtx.lineWidth = Math.max(13, snake.getRadius() * scaleX);
    routeCtx.stroke();
    routeCtx.strokeStyle = 'rgba(220, 255, 255, .8)';
    routeCtx.lineWidth = 2;
    routeCtx.setLineDash(dashedRoute);
    routeCtx.stroke();
    routeCtx.setLineDash(solidRoute);
    // Dashed guidance marks an intended pickup beyond the safe, simulated arc.
    if (target && !reachable) {
      routeCtx.beginPath();
      routeCtx.moveTo(centerX + routePoints[guideIndex * 2] * scaleX,
        centerY - routePoints[guideIndex * 2 + 1] * scaleY);
      routeCtx.lineTo(centerX + target.x * scaleX, centerY - target.y * scaleY);
      routeCtx.setLineDash(dashedRoute);
      routeCtx.strokeStyle = target.dna ? 'rgba(255, 213, 69, .8)' : 'rgba(177, 255, 144, .7)';
      routeCtx.lineWidth = 2;
      routeCtx.stroke();
      routeCtx.setLineDash(solidRoute);
    }
    if (target) {
      const tx = centerX + target.x * scaleX;
      const ty = centerY - target.y * scaleY;
      routeCtx.beginPath();
      routeCtx.arc(tx, ty, Math.max(15, snake.getRadius() * scaleX + 9), 0, Math.PI * 2);
      routeCtx.strokeStyle = target.dna ? '#ffd545' : '#b1ff90';
      routeCtx.lineWidth = 3;
      routeCtx.stroke();
      routeCtx.font = 'bold 13px Arial, sans-serif';
      routeCtx.lineJoin = 'round';
      routeCtx.strokeStyle = '#071b11';
      routeCtx.lineWidth = 4;
      routeCtx.strokeText(target.dna ? 'DNA target' : 'Food target', tx + 17, ty - 16);
      routeCtx.fillStyle = target.dna ? '#ffd545' : '#b1ff90';
      routeCtx.fillText(target.dna ? 'DNA target' : 'Food target', tx + 17, ty - 16);
    }
    if (!target) {
      routeCtx.save();
      routeCtx.translate(centerX + x * scaleX, centerY - y * scaleY);
      routeCtx.rotate(-heading);
      routeCtx.beginPath();
      routeCtx.moveTo(12, 0);
      routeCtx.lineTo(-5, -7);
      routeCtx.lineTo(-5, 7);
      routeCtx.closePath();
      routeCtx.fillStyle = '#dcffff';
      routeCtx.fill();
      routeCtx.restore();
    }
    if (routeCanvas.style.display !== 'block') routeCanvas.style.display = 'block';
  }

  function escapingOrbit(px, py, snake) {
    const now = Date.now();
    const direction = snake.direction_0;
    let motion = state.motion;
    if (!motion) {
      state.motion = { x: px, y: py, at: now, direction, turn: 0 };
      return false;
    }
    if (now < state.escapeUntil) {
      motion.x = px;
      motion.y = py;
      motion.at = now;
      motion.direction = direction;
      motion.turn = 0;
      return true;
    }
    motion.turn += Math.abs(angleDelta(motion.direction, direction));
    motion.direction = direction;
    const elapsed = now - motion.at;
    if (elapsed < 3000) return false;
    const speed = Math.max(60, Math.min(snake.currentSpeed || 120, 360));
    const orbit = motion.turn > Math.PI * 1.5 &&
      Math.hypot(px - motion.x, py - motion.y) <
        Math.max(75, speed * elapsed / 1000 * 0.34);
    motion.x = px;
    motion.y = py;
    motion.at = now;
    motion.turn = 0;
    if (!orbit) return false;
    // Continue forward without food attraction until the head exits the loop.
    state.escapeUntil = now + Math.max(2600, Math.min(5200, 320000 / speed));
    return true;
  }

  function steer() {
    if (!state.running) return;
    try {
      const app = client();
      const view = app?.gameView;
      if (!view || view.finished) {
        routePlan = null;
        releaseSprint();
        opponents.clear();
        return;
      }
      const player = view.playerSnakeView;
      const snake = player?.snake;
      if (!snake || snake.isDying() || !player.getParent_0()) {
        routePlan = null;
        releaseSprint();
        opponents.clear();
        show('Waiting for spawn');
        return;
      }
      if (!view.playerSnakeController || !view.foodViews || !view.snakes) {
        throw new Error('Game controls changed; update the userscript.');
      }
      if (state.lastSnakeId !== snake.id_0) {
        releaseSprint();
        opponents.clear();
        if (state.lastSnakeId !== null) state.deaths++;
        state.lastSnakeId = snake.id_0;
        state.motion = null;
        state.escapeUntil = 0;
        state.stopRequestedAt = state.stopStartedAt = state.stopReleaseAt = 0;
        state.ghostRequestedAt = 0;
      }
      const game = document.getElementById('SnakeGame').contentWindow;
      const config = game.nescg2.i_2();
      const radius = config.worldRadius;
      const arena = readArena(view, snake, game.nesc.gameTime(),
        config.skills.get_14(game.nescg2.GHOST)?.duration || 0);
      const escaping = snake.stop_0 ? false : escapingOrbit(arena.px, arena.py, snake);
      const normal = emergencyHeading(game, view, arena, snake, radius, escaping);
      const plan = planSprint(game, view, arena, snake, radius, normal, escaping);
      view.playerSnakeController.snakeDirection = plan.heading;
      routePlan = plan;
      show(`${plan.label} · length ${Math.floor(snake.weight)} · DNA in view ${arena.dnaNearby} · deaths ${state.deaths}`);
    } catch (error) {
      console.error('[Wormax DNA bot]', error);
      stop(error.message || 'Game interface changed');
    }
  }

  function findLabel(root, text) {
    if (!root || root.visible === false) return null;
    if (root.text_0 && String(root.text_0) === text) return root;
    const children = root.children;
    for (let i = 0; i < (children?.size_0 || 0); i++) {
      const label = findLabel(children.items[i], text);
      if (label) return label;
    }
    return null;
  }

  function clickActor(actor, stage) {
    if (!actor || !stage) return false;
    const canvas = document.querySelector('canvas');
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const viewport = stage.viewport_0;
    if (!viewport?.worldWidth || !viewport?.worldHeight) return false;
    let x = (actor.width_0 || 0) / 2, y = (actor.height_0 || 0) / 2;
    for (let parent = actor; parent && parent !== stage.root; parent = parent.parent_0) {
      x += parent.x_0 || 0;
      y += parent.y_0 || 0;
    }
    const cx = rect.left + x / viewport.worldWidth * rect.width;
    const cy = rect.top + (1 - y / viewport.worldHeight) * rect.height;
    if (document.elementFromPoint(cx, cy) !== canvas) return false;
    const options = { bubbles: true, cancelable: true, button: 0,
      clientX: cx, clientY: cy, view: window };
    canvas.dispatchEvent(new MouseEvent('mousedown', options));
    document.dispatchEvent(new MouseEvent('mouseup', options));
    state.lastAction = Date.now();
    return true;
  }

  function closeSkippableAd() {
    const gpt = document.getElementById('adContainerGpt');
    const skip = document.querySelector('#gptWrapperSkipButtonClickable a');
    if (gpt && getComputedStyle(gpt).display !== 'none' && skip &&
        getComputedStyle(skip.parentElement).display !== 'none') {
      skip.click();
      state.lastAction = Date.now();
      return true;
    }
    for (const id of ['adinplayAdContainer', 'adContainer']) {
      const container = document.getElementById(id);
      if (!container || getComputedStyle(container).display === 'none') continue;
      for (const element of container.querySelectorAll('button, a, [role=\"button\"], span, div')) {
        const label = (element.getAttribute('aria-label') || element.textContent || '').trim();
        if (!/^(close|skip|skip ad|×)$/i.test(label)) continue;
        if (element.children.length && !element.matches('button, a, [role=\"button\"]')) continue;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || getComputedStyle(element).visibility === 'hidden') continue;
        element.click();
        state.lastAction = Date.now();
        return true;
      }
    }
    return false;
  }

  function menu() {
    if (!state.running || !CONFIG.replay || Date.now() - state.lastAction < 2100) return;
    try {
      const app = client();
      if (!app?.uiStage?.root) {
        show('Waiting for game');
        return;
      }
      const root = app.uiStage.root;
      const stage = app.uiStage;
      if ((!app.gameView || app.gameView.finished) && closeSkippableAd()) {
        show('Closing advertisement');
        return;
      }
      if (!app.gameView && findLabel(root, 'Reward taken')) {
        let button = findLabel(root, 'OK');
        while (button && !button.clickListener) button = button.parent_0;
        if (clickActor(button, stage)) show('Closing quest confirmation');
        return;
      }
      const gift = findLabel(root, "It's better with presents!");
      if (gift) {
        // Only dismiss the game's own optional video-offer popup.
        const modal = gift.parent_0?.parent_0;
        const close = modal?.children?.items?.slice(0, modal.children.size_0)
          .find(child => child.clickListener && child.x_0 > modal.width_0 * 0.7);
        if (clickActor(close, stage)) show('Entering arena');
        else show('Waiting for advertisement or popup');
        return;
      }
      if (app.gameView && !app.gameView.finished) return;
      const label = app.gameView
        ? findLabel(root, 'END THE GAME')
        : findLabel(root, 'PLAY AGAIN') || findLabel(root, 'PLAY');
      if (label) {
        let button = label;
        while (button && !button.clickListener) button = button.parent_0;
        if (clickActor(button, stage)) show(app.gameView ? 'Ending match' : 'Joining match');
        else show('Waiting for advertisement');
      } else {
        let back = !app.gameView && findLabel(root, 'BACK');
        while (back && !back.clickListener) back = back.parent_0;
        if (clickActor(back, stage)) show('Returning to main menu');
        else show('Waiting for menu or advertisement');
      }
    } catch (error) {
      console.error('[Wormax DNA bot]', error);
      stop(error.message || 'Game menu changed');
    }
  }

  setInterval(steer, CONFIG.steeringIntervalMs);
  setInterval(menu, CONFIG.menuIntervalMs);
  setInterval(collectQuestRewards, CONFIG.questIntervalMs);
})();
