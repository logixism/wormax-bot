// ==UserScript==
// @name         Wormax DNA Farmer
// @namespace    local.wormax.dna
// @version      1.5.0
// @description  Plan safe routes, track opponents, prioritize DNA and pickups, coordinate sprint and emergency skills, and replay.
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
// The overlay draws the chosen multi-turn plan up to the next predicted pickup.
// A dashed link marks a target approached, but not collected, within that plan.
// Stopped opponents remain obstacles. Fresh, observed ghosts are passable only
// while their remaining time exceeds the route horizon plus a safety margin.
// Ghosts first seen already transparent have unknown age and are avoided.
// TURBO chases valuable pickups or clear escapes; paid chases preserve a length
// reserve. Opponent ages are exposed by window.__wormaxDnaBot.status().opponents.
// Lookahead grows with turning radius. Collision-free routes outrank food, and
// similarly valuable pickups do not repeatedly steal the current target.
// The planner accounts for announced opponent turns and the body left behind.
// Inspect window.__wormaxDnaBot.status().intent for the current goal and safety estimate.
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
    maxPredictionSteps: 24,
    emergencySeconds: 0.9,
    ghostExpiryMarginMs: 700,
    sprintReserveWeight: 100,
    targetCommitmentBonus: 0.12,
  };
  const state = {
    running: false, status: 'Paused', deaths: 0, lastSnakeId: null, lastAction: 0,
    motion: null, escapeUntil: 0, claimedQuests: 0, questPending: false,
    questRetryAt: 0, questError: false, stopRequestedAt: 0, stopStartedAt: 0,
    stopReleaseAt: 0, ghostRequestedAt: 0, sprintRequestedAt: 0, sprintReleasedAt: 0,
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
    state.sprintReleasedAt = game?.nesc?.gameTime?.() ?? Date.now();
    state.sprintRequestedAt = 0;
  }

  function stop(message = 'Paused') {
    state.running = false;
    if (state.stopRequestedAt && !state.stopReleaseAt)
      releaseStop(document.getElementById('SnakeGame')?.contentWindow?.nesc?.gameTime?.() ?? Date.now());
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
    intent: routePlan ? {
      heading: routePlan.heading, sprinting: routePlan.turbo,
      lookaheadMs: routePlan.steps * CONFIG.predictionStepSeconds * 1000,
      collisionInMs: Number.isFinite(routePlan.collisionAt) ? routePlan.collisionAt * 1000 : null,
      clearance: routePlan.clearance,
      target: routePlan.target ? { x: routePlan.target.x, y: routePlan.target.y,
        dna: routePlan.target.dna } : null,
    } : null,
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

  function distanceToSegment(x, y, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1,
      ((x - ax) * dx + (y - ay) * dy) / lengthSquared)) : 0;
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
  }

  function segmentDistance(ax, ay, bx, by, cx, cy, dx, dy) {
    const ux = bx - ax, uy = by - ay, vx = dx - cx, vy = dy - cy;
    const denominator = ux * vy - uy * vx;
    if (denominator !== 0) {
      const t = ((cx - ax) * vy - (cy - ay) * vx) / denominator;
      const s = ((cx - ax) * uy - (cy - ay) * ux) / denominator;
      if (t >= 0 && t <= 1 && s >= 0 && s <= 1) return 0;
    }
    return Math.min(
      distanceToSegment(ax, ay, cx, cy, dx, dy),
      distanceToSegment(bx, by, cx, cy, dx, dy),
      distanceToSegment(cx, cy, ax, ay, bx, by),
      distanceToSegment(dx, dy, ax, ay, bx, by));
  }

  // The client turns along an arc, then travels straight after reaching its heading.
  function advancePose(pose, desired, distance, radius) {
    const from = pose[2];
    const turn = Math.max(-distance / radius,
      Math.min(distance / radius, angleDelta(from, desired)));
    const to = from + turn;
    if (Math.abs(turn) > 1e-8) {
      const signedRadius = Math.sign(turn) * radius;
      pose[0] += (Math.sin(to) - Math.sin(from)) * signedRadius;
      pose[1] += (Math.cos(from) - Math.cos(to)) * signedRadius;
    }
    const straight = Math.max(0, distance - Math.abs(turn) * radius);
    pose[0] += Math.cos(to) * straight;
    pose[1] += Math.sin(to) * straight;
    pose[2] = to;
  }

  function observeOpponent(snake, now, ghostDurationMs, horizon) {
    let other = opponents.get(snake.id_0);
    if (!other || other.snake !== snake || now < other.seenAt ||
        now - other.seenAt > CONFIG.steeringIntervalMs * 3) {
      other = { snake, ghost: !!snake.ghost, ghostSince: null,
        ghostSeenAt: snake.ghost ? now : null, seenAt: now,
        points: new Float64Array((CONFIG.maxPredictionSteps + 1) * 2) };
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
        horizon * 1000 + CONFIG.ghostExpiryMarginMs;
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

  const forecastPose = new Float64Array(3);

  function forecastOpponent(other, steps) {
    const snake = other.snake;
    const position = snake.getPosition_0?.() || snake.lastTickPosition;
    if (!position) return false;
    const radius = Math.max(20, snake.getRotationRadius());
    forecastPose[0] = position.x_0;
    forecastPose[1] = position.y_0;
    forecastPose[2] = snake.direction_0;
    other.points[0] = position.x_0;
    other.points[1] = position.y_0;
    other.speed = other.stopped ? 0 : Math.max(0, snake.currentSpeed ?? 120);
    other.turnRate = other.speed / radius;
    other.resumeSpeed = Math.max(snake.currentSpeed ?? 0,
      (snake.turbo ? snake.lastTickTurboSpeed : snake.lastTickNormalSpeed) ?? 120);
    other.pickupRadius = snake.getRadius() + 8;
    const desired = snake.direction_0 + (snake.directionDelta || 0);
    let distance = 0;
    for (let step = 1; step <= steps; step++) {
      const next = other.stopped ? 0
        : travelDistance(snake, step * CONFIG.predictionStepSeconds, snake.turbo);
      advancePose(forecastPose, desired, next - distance, radius);
      distance = next;
      other.points[step * 2] = forecastPose[0];
      other.points[step * 2 + 1] = forecastPose[1];
    }
    return true;
  }

  function readArena(view, snake, now, ghostDurationMs) {
    const px = view.playerSnakeView.x_0;
    const py = view.playerSnakeView.y_0;
    const foods = [];
    const toxins = [];
    const selfRadius = snake.getRadius();
    const turnDiameter = snake.getRotationRadius() * 2 + selfRadius * 2;
    const steps = Math.max(CONFIG.predictionSteps, Math.min(CONFIG.maxPredictionSteps,
      Math.ceil((2 * snake.getRotationRadius() /
        Math.max(60, snake.lastTickNormalSpeed || 120) + 0.45) /
          CONFIG.predictionStepSeconds)));
    const horizon = steps * CONFIG.predictionStepSeconds;
    const reach = travelDistance(snake, horizon, true) + selfRadius + 180;
    const foodRange = Math.max(900, reach);
    const committed = routePlan?.goal?.source || routePlan?.target?.source;
    let dnaNearby = 0;
    for (const bucket of entries(view.foodViews)) {
      for (const entry of bucket) {
        const food = entry.value_0;
        const name = food?.skin?.name_1;
        if (!name || food.foodRemoving || food.eatenBy) continue;
        const x = food.x_0, y = food.y_0;
        const distance = Math.hypot(x - px, y - py);
        if (distance > foodRange) continue;
        if (name.startsWith('TOXIC_')) {
          if (distance < reach) toxins.push({ x, y });
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
          value = snake.hasBooster(food.skin) ? 2 : 12;
        } else {
          value = 1;
        }
        // A close pickup behind the head cannot be reached with this turning radius.
        if (distance < turnDiameter &&
            Math.cos(snake.direction_0 - Math.atan2(y - py, x - px)) < -0.5) continue;
        const priority = value / (distance + 100) *
          (food === committed ? 1 + CONFIG.targetCommitmentBonus : 1);
        foods.push({ source: food, x, y, distance, value, priority,
          dna: name === 'BOOSTER_ESSENCE', opponentArrival: Infinity });
      }
    }
    foods.sort((a, b) => b.priority - a.priority);
    foods.length = Math.min(foods.length, CONFIG.maxFoods);

    const obstacles = [];
    const heads = [];
    for (const bucket of entries(view.snakes)) {
      for (const entry of bucket) {
        const other = entry.value_0;
        if (!other || other.id_0 === snake.id_0 || other.isDying()) continue;
        const tracked = observeOpponent(other, now, ghostDurationMs, horizon);
        const radius = other.getRadius() + selfRadius + CONFIG.dangerMargin;
        tracked.radius = radius;
        const points = other.segments?.array;
        const count = tracked.passable ? 0
          : Math.min(points?.length || 0, other.segments?.size_1?.() ?? Infinity);
        let prev = null;
        for (let i = 0; i < count; i++) {
          const pos = points[i]?.pos;
          if (!pos) { prev = null; continue; }
          const connected = prev && Math.hypot(pos.x_0 - prev.x_0, pos.y_0 - prev.y_0) <
            Math.max(180, other.getRadius() * 4);
          const ax = connected ? prev.x_0 : pos.x_0;
          const ay = connected ? prev.y_0 : pos.y_0;
          if (distanceToSegment(px, py, ax, ay, pos.x_0, pos.y_0) < reach + radius)
            obstacles.push({ ax, ay, bx: pos.x_0, by: pos.y_0, radius });
          prev = pos;
        }
        if (forecastOpponent(tracked, steps)) {
          const headReach = reach + tracked.resumeSpeed * horizon + radius;
          if (Math.hypot(tracked.points[0] - px, tracked.points[1] - py) < headReach)
            heads.push(tracked);
        }
      }
    }
    for (const [id, other] of opponents) {
      if (other.seenAt !== now) opponents.delete(id);
    }
    // Discount food that an opponent's announced route is likely to collect first.
    for (const food of foods) {
      for (const head of heads) {
        for (let step = 1; step <= steps; step++) {
          if (step * CONFIG.predictionStepSeconds >= food.opponentArrival) break;
          const index = step * 2;
          if (distanceToSegment(food.x, food.y, head.points[index - 2],
              head.points[index - 1], head.points[index], head.points[index + 1]) <=
              head.pickupRadius) {
            food.opponentArrival = step * CONFIG.predictionStepSeconds;
            break;
          }
        }
      }
    }
    return { px, py, foods, toxins, obstacles, heads, selfRadius, dnaNearby, steps, horizon };
  }

  const closestFoodApproach = new Float64Array(CONFIG.maxFoods);
  const pickupArrival = new Float64Array(CONFIG.maxFoods);
  const predictionStrides = new Float64Array(CONFIG.maxPredictionSteps);
  const candidateHeadings = new Float64Array(52);
  const candidateGoals = new Int16Array(52);
  const planningPose = new Float64Array(3);
  const candidatePath = new Float64Array((CONFIG.maxPredictionSteps + 1) * 2);
  const normalPath = new Float64Array(candidatePath.length);
  const cautiousPath = new Float64Array(candidatePath.length);
  const sprintPath = new Float64Array(candidatePath.length);
  const stepRisk = { clearance: Infinity, uncertain: Infinity };

  function pathRisk(arena, ax, ay, bx, by, step, worldRadius, mode, bend = 0) {
    stepRisk.clearance = worldRadius - CONFIG.worldMargin - arena.selfRadius -
      Math.max(Math.hypot(ax, ay), Math.hypot(bx, by)) - bend;
    stepRisk.uncertain = Infinity;
    if (mode === 'ghost') {
      if (step < arena.steps) return;
      // Use intangibility to reach open space, not to finish the plan inside a body.
      ax = bx;
      ay = by;
    }
    for (const line of arena.obstacles) {
      const margin = line.radius + bend + 250;
      if (Math.max(ax, bx) < Math.min(line.ax, line.bx) - margin ||
          Math.min(ax, bx) > Math.max(line.ax, line.bx) + margin ||
          Math.max(ay, by) < Math.min(line.ay, line.by) - margin ||
          Math.min(ay, by) > Math.max(line.ay, line.by) + margin) continue;
      stepRisk.clearance = Math.min(stepRisk.clearance,
        segmentDistance(ax, ay, bx, by, line.ax, line.ay, line.bx, line.by) -
          line.radius - bend);
    }
    for (const head of arena.heads) {
      if (head.passable) continue;
      const index = step * 2;
      const points = head.points;
      const clearance = distanceToSegment(0, 0,
        ax - points[index - 2], ay - points[index - 1],
        bx - points[index], by - points[index + 1]) - head.radius - 15 - bend;
      stepRisk.clearance = Math.min(stepRisk.clearance, clearance);
      stepRisk.uncertain = Math.min(stepRisk.uncertain,
        clearance - headTurnReach(head, step * CONFIG.predictionStepSeconds));
      // A crossing head leaves a body behind; the gap does not reopen after it passes.
      for (let trail = 2; trail < index; trail += 2) {
        stepRisk.clearance = Math.min(stepRisk.clearance,
          segmentDistance(ax, ay, bx, by, points[trail - 2], points[trail - 1],
            points[trail], points[trail + 1]) - head.radius - bend);
      }
    }
  }

  function chooseHeading(arena, snake, worldRadius, escaping, mode = 'normal', turbo = false) {
    const { px, py, selfRadius, steps } = arena;
    const foods = arena.foods;
    const foodCount = escaping ? 0 : foods.length;
    const current = snake.direction_0;
    const rotationRadius = Math.max(20, snake.getRotationRadius());
    const dt = CONFIG.predictionStepSeconds;
    const pickupRadius = selfRadius + 8;
    const committed = routePlan?.goal?.source || routePlan?.target?.source;
    const points = turbo ? sprintPath : mode === 'cautious' ? cautiousPath : normalPath;
    let distance = 0;
    for (let step = 1; step <= steps; step++) {
      const next = travelDistance(snake, step * dt, turbo);
      predictionStrides[step - 1] = next - distance;
      distance = next;
    }
    candidateGoals.fill(-1);
    let candidateCount = 1;
    candidateHeadings[0] = current;
    for (let i = -11; i <= 12; i++) {
      if (i !== 0) candidateHeadings[candidateCount++] = current + i * Math.PI / 12;
    }
    if (routePlan) candidateHeadings[candidateCount++] = routePlan.heading;
    if (Math.hypot(px, py) + distance > worldRadius - CONFIG.worldMargin - selfRadius - 130)
      candidateHeadings[candidateCount++] = Math.atan2(-py, -px);
    for (let i = 0; i < Math.min(foodCount, 8); i++) {
      const toward = Math.atan2(foods[i].y - py, foods[i].x - px);
      for (let offset = -1; offset <= 1; offset++) {
        candidateHeadings[candidateCount] = toward + offset * 0.55;
        candidateGoals[candidateCount++] = i;
      }
    }

    let best = current, bestScore = -Infinity, bestDanger = Infinity;
    let bestCollision = -Infinity, bestClearance = -Infinity, bestEndHeading = current;
    let bestTarget = null, bestGoal = null, bestArrival = Infinity;
    for (let candidate = 0; candidate < candidateCount; candidate++) {
      const desired = candidateHeadings[candidate];
      const goalIndex = candidateGoals[candidate];
      const goal = goalIndex >= 0 ? foods[goalIndex] : null;
      let following = !!goal;
      let danger = 0, collisionAt = Infinity, clearance = Infinity, terminalClearance = Infinity;
      planningPose[0] = px;
      planningPose[1] = py;
      planningPose[2] = current;
      candidatePath[0] = px;
      candidatePath[1] = py;
      closestFoodApproach.fill(Infinity, 0, foodCount);
      pickupArrival.fill(Infinity, 0, foodCount);
      for (let step = 1; step <= steps; step++) {
        const previousX = planningPose[0], previousY = planningPose[1];
        const previousHeading = planningPose[2];
        // Try a short detour followed by a turn toward the pickup, not only fixed rays.
        const toward = following && (step - 1) * dt >= 0.6
          ? Math.atan2(goal.y - previousY, goal.x - previousX)
          : following ? desired : goal ? previousHeading : desired;
        advancePose(planningPose, toward, predictionStrides[step - 1], rotationRadius);
        const x = planningPose[0], y = planningPose[1];
        candidatePath[step * 2] = x;
        candidatePath[step * 2 + 1] = y;
        const dx = x - previousX, dy = y - previousY;
        const lengthSquared = dx * dx + dy * dy;
        for (let i = 0; i < foodCount; i++) {
          const food = foods[i];
          const t = lengthSquared ? Math.max(0, Math.min(1,
            ((food.x - previousX) * dx + (food.y - previousY) * dy) / lengthSquared)) : 0;
          const separation = Math.hypot(food.x - previousX - t * dx,
            food.y - previousY - t * dy);
          closestFoodApproach[i] = Math.min(closestFoodApproach[i], separation);
          if (separation <= pickupRadius && pickupArrival[i] === Infinity)
            pickupArrival[i] = (step - 1 + t) * dt;
        }
        if (following && pickupArrival[goalIndex] < Infinity) following = false;
        const bend = rotationRadius * (1 - Math.cos((planningPose[2] - previousHeading) / 2));
        pathRisk(arena, previousX, previousY, x, y, step, worldRadius, mode, bend);
        const safe = stepRisk.clearance;
        clearance = Math.min(clearance, safe);
        terminalClearance = safe;
        if (safe < 0) {
          collisionAt = Math.min(collisionAt, step * dt);
          danger += 900 - 20 * safe;
        } else if (safe < 70) danger += (70 - safe) ** 2 / 140;
        const uncertain = stepRisk.uncertain;
        const caution = mode === 'cautious' ? 1 : 0.2;
        if (uncertain < 0) danger += caution * (150 - 5 * uncertain);
        else if (uncertain < 35) danger += caution * (35 - uncertain) ** 2 / 10;
        for (const toxin of arena.toxins) {
          const separation = distanceToSegment(toxin.x, toxin.y,
            previousX, previousY, x, y) - selfRadius - 10 - bend;
          if (separation < 0) danger += 35;
          else if (separation < 25) danger += (25 - separation) / 2;
        }
      }

      let reward = 0;
      for (let i = 0; i < foodCount; i++) {
        const food = foods[i];
        const arrival = pickupArrival[i];
        let value;
        if (arrival < Infinity) {
          const centered = Math.min(1, (pickupRadius - closestFoodApproach[i]) /
            (pickupRadius * 0.4));
          value = (0.3 + 0.7 * centered) / (1 + arrival / 0.25);
        } else {
          value = 0.15 * Math.max(0, (food.distance - closestFoodApproach[i]) /
            Math.max(1, food.distance - pickupRadius));
        }
        if (food.opponentArrival + dt < arrival) value *= 0.2;
        if (food.source === committed) value *= 1 + CONFIG.targetCommitmentBonus;
        reward += food.value * 100 / (food.distance + 100) * value;
      }
      const score = reward - danger - 0.6 * Math.abs(angleDelta(current, desired)) +
        Math.max(0, Math.min(250, terminalClearance)) * 0.015 -
        (routePlan ? 0.2 * Math.abs(angleDelta(routePlan.heading, desired)) : 0);
      // Safety is a hard priority: food can never buy a predicted collision.
      if (collisionAt > bestCollision ||
          (collisionAt === bestCollision && score > bestScore)) {
        bestCollision = collisionAt;
        bestScore = score;
        bestDanger = danger;
        bestClearance = clearance;
        bestEndHeading = planningPose[2];
        best = desired;
        bestGoal = goal;
        bestTarget = null;
        bestArrival = Infinity;
        let bestApproach = 0;
        for (let i = 0; i < foodCount; i++) {
          const food = foods[i];
          if (pickupArrival[i] < bestArrival) {
            bestArrival = pickupArrival[i];
            bestTarget = food;
          } else if (bestArrival === Infinity) {
            const attraction = food.priority * Math.max(0,
              (food.distance - closestFoodApproach[i]) / Math.max(1, food.distance - pickupRadius));
            if (attraction > bestApproach) {
              bestApproach = attraction;
              bestTarget = food;
            }
          }
        }
        for (let i = 0; i < (steps + 1) * 2; i++) points[i] = candidatePath[i];
      }
    }
    return { heading: best, target: bestTarget, goal: bestGoal || bestTarget, arrival: bestArrival,
      danger: bestDanger, collisionAt: bestCollision, clearance: bestClearance,
      points, steps, endHeading: bestEndHeading, worldRadius, mode, turbo };
  }

  function headTurnReach(head, seconds) {
    if (head.stopped) return head.resumeSpeed * seconds;
    return Math.min(75, head.speed * seconds *
      Math.min(1, head.turnRate * seconds * 0.45));
  }

  function assessThreat(arena, plan, stationary = false) {
    const dt = CONFIG.predictionStepSeconds;
    let direct = Infinity, uncertain = Infinity;
    const steps = Math.min(arena.steps, Math.round(CONFIG.emergencySeconds / dt));
    for (let step = 1; step <= steps; step++) {
      const index = step * 2;
      pathRisk(arena,
        stationary ? arena.px : plan.points[index - 2],
        stationary ? arena.py : plan.points[index - 1],
        stationary ? arena.px : plan.points[index],
        stationary ? arena.py : plan.points[index + 1],
        step, plan.worldRadius, 'normal');
      if (stepRisk.clearance < 0) direct = Math.min(direct, step * dt);
      if (stepRisk.uncertain < 0) uncertain = Math.min(uncertain, step * dt);
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
    const holding = !!state.sprintRequestedAt;
    const brakingDistance = acceleration > 0
      ? Math.max(0, (turboSpeed * turboSpeed - normalSpeed * normalSpeed) / (2 * acceleration))
      : Infinity;
    const pickupDistance = brakingDistance + arena.selfRadius * 2 + (holding ? 30 : 70);
    const target = plan.target;
    const chasing = target && target.distance > pickupDistance &&
      (free || target.dna || target.value >= 7);
    if (snake.stop_0 || plan.label === 'Braking' || plan.label === 'Ghost expiring' ||
        (plan.label === 'Ghosting' && !snake.ghost) ||
        (!holding && !fleeing && now - state.sprintReleasedAt < 650) ||
        !(turboSpeed > normalSpeed && normalSpeed > 0 && acceleration > 0) ||
        !button || !snake.canUseSkill(button.skill) ||
        (!button.skillState?.activated_0 && !skillReady(button, snake, now)) ||
        (!free && !fleeing &&
          snake.weight <= game.nescg2.i_2().minSnakeWeight +
            CONFIG.sprintReserveWeight + (holding ? 0 : 20)) ||
        (!fleeing && !chasing)) {
      releaseSprint();
      return plan;
    }
    const sprint = chooseHeading(arena, snake, radius, fleeing,
      plan.mode === 'ghost' ? 'ghost' : 'cautious', true);
    // Check the full faster trajectory, not the short, normal-speed safe corridor.
    if (sprint.collisionAt < Infinity || sprint.danger > 0 ||
        Math.abs(angleDelta(snake.direction_0, sprint.heading)) > (holding ? 0.55 : 0.35) ||
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
        arena.horizon * 1000 + CONFIG.ghostExpiryMarginMs;
    let plan = chooseHeading(arena, snake, radius,
      escaping || (snake.ghost && !ghostSafe), ghostSafe ? 'ghost' : 'normal');
    if (snake.ghost) {
      if (snake.stop_0 && state.stopRequestedAt) releaseStop(now);
      plan.label = ghostSafe ? 'Ghosting' : 'Ghost expiring';
      return planSprint(game, view, arena, snake, radius, plan, escaping);
    }
    if (snake.stop_0 && !state.stopStartedAt) {
      state.stopStartedAt = now;
      state.motion = null;
    }
    if (!snake.stop_0 && state.stopStartedAt) {
      state.stopRequestedAt = state.stopStartedAt = state.stopReleaseAt = 0;
      state.motion = null;
    }
    const ghostReady = skillReady(ghostButton, snake, now) &&
      now - state.ghostRequestedAt > 1100;
    const stopPending = state.stopRequestedAt && !state.stopReleaseAt &&
      now - state.stopRequestedAt < 1200;
    if (snake.stop_0 || stopPending) {
      releaseSprint();
      plan = chooseHeading(arena, snake, radius, true, 'cautious');
      const moving = assessThreat(arena, plan);
      const stationary = assessThreat(arena, plan, true);
      const elapsed = now - (state.stopStartedAt || state.stopRequestedAt);
      const exhausted = elapsed >= Math.max(400, (stopButton?.skillState?.duration || 3000) - 550);
      if (ghostReady && (stationary.direct <= 0.3 || stationary.uncertain <= 0.25 ||
          (exhausted && (moving.direct <= 0.9 || moving.uncertain <= 0.55)))) {
        const exit = chooseHeading(arena, snake, radius, true, 'ghost');
        if (exit.collisionAt > Math.min(stationary.direct, moving.direct, plan.collisionAt)) {
          game.nescc.useSkill(snake, ghostButton.skill);
          state.ghostRequestedAt = now;
          releaseStop(now);
          plan.label = 'Ghosting';
          return plan;
        }
      }
      if (snake.stop_0 && ((elapsed > 450 && plan.collisionAt === Infinity &&
          moving.uncertain > 0.65 && stationary.direct > 0.35) || exhausted))
        releaseStop(now);
      plan.label = 'Braking';
      return plan;
    }
    if (state.ghostRequestedAt && now - state.ghostRequestedAt < 1200) {
      releaseSprint();
      plan.label = 'Ghosting';
      return plan;
    }
    const risk = assessThreat(arena, plan);
    if (plan.collisionAt === Infinity && risk.direct > 0.9 && risk.uncertain > 0.75) {
      plan.label = escaping ? 'Escaping orbit' : 'Playing';
      return planSprint(game, view, arena, snake, radius, plan, escaping);
    }
    plan = chooseHeading(arena, snake, radius, true, 'cautious');
    plan.label = 'Evading';
    const escape = assessThreat(arena, plan);
    if (plan.collisionAt === Infinity && escape.direct > 0.9 && escape.uncertain > 0.7) {
      releaseSprint();
      return plan;
    }
    // Try a clear acceleration escape before spending either cooldown skill.
    const sprint = planSprint(game, view, arena, snake, radius, plan, true);
    if (sprint.turbo) return sprint;
    const stationary = assessThreat(arena, plan, true);
    const reactionWindow = Math.max(0.9, Math.min(1.8,
      snake.getRotationRadius() / Math.max(60, snake.lastTickNormalSpeed || 120) + 0.2));
    const urgent = Math.min(escape.direct, plan.collisionAt) <= reactionWindow ||
      escape.uncertain <= 0.7;
    const stopReady = skillReady(stopButton, snake, now) &&
      now - state.stopRequestedAt > 1100;
    if (urgent && stopReady && stationary.direct > 0.9 && stationary.uncertain > 0.65) {
      game.nescc.useSkill(snake, stopButton.skill);
      state.stopRequestedAt = now;
      state.stopStartedAt = state.stopReleaseAt = 0;
      state.motion = null;
      plan.label = 'Braking';
      return plan;
    }
    if (urgent && ghostReady) {
      const exit = chooseHeading(arena, snake, radius, true, 'ghost');
      if (exit.collisionAt > plan.collisionAt ||
          (escape.uncertain <= 0.3 && exit.clearance > plan.clearance + 20)) {
        game.nescc.useSkill(snake, ghostButton.skill);
        state.ghostRequestedAt = now;
        plan.label = 'Ghosting';
      }
    }
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
    const points = routePlan.points;
    const target = routePlan.target;
    const reachable = Number.isFinite(routePlan.arrival);
    let guideIndex = 0;
    let guideDistance = target
      ? (target.x - points[0]) ** 2 + (target.y - points[1]) ** 2 : Infinity;
    if (target && !reachable) {
      for (let step = 1; step <= routePlan.steps; step++) {
        const distance = (target.x - points[step * 2]) ** 2 +
          (target.y - points[step * 2 + 1]) ** 2;
        if (distance < guideDistance) {
          guideDistance = distance;
          guideIndex = step;
        }
      }
    }
    const routeEnd = reachable
      ? Math.min(routePlan.steps, Math.ceil(routePlan.arrival / CONFIG.predictionStepSeconds))
      : target ? guideIndex : routePlan.steps;
    routeCtx.beginPath();
    routeCtx.moveTo(centerX + player.x_0 * scaleX, centerY - player.y_0 * scaleY);
    for (let step = 1; step <= routeEnd; step++) {
      const fraction = reachable ? Math.min(1, Math.max(0,
        routePlan.arrival / CONFIG.predictionStepSeconds - step + 1)) : 1;
      const index = step * 2;
      const x = points[index - 2] + (points[index] - points[index - 2]) * fraction;
      const y = points[index - 1] + (points[index + 1] - points[index - 1]) * fraction;
      routeCtx.lineTo(centerX + x * scaleX, centerY - y * scaleY);
    }
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
      routeCtx.moveTo(centerX + points[guideIndex * 2] * scaleX,
        centerY - points[guideIndex * 2 + 1] * scaleY);
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
      routeCtx.translate(centerX + points[routeEnd * 2] * scaleX,
        centerY - points[routeEnd * 2 + 1] * scaleY);
      routeCtx.rotate(-routePlan.endHeading);
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
        state.sprintReleasedAt = 0;
      }
      const game = document.getElementById('SnakeGame').contentWindow;
      const config = game.nescg2.i_2();
      const radius = config.worldRadius;
      const arena = readArena(view, snake, game.nesc.gameTime(),
        config.skills.get_14(game.nescg2.GHOST)?.duration || 0);
      const escaping = snake.stop_0 ? false : escapingOrbit(arena.px, arena.py, snake);
      const plan = emergencyHeading(game, view, arena, snake, radius, escaping);
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
