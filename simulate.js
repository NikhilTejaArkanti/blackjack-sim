// Blackjack simulation engine. Plays hands fully automatically, always
// following the basic-strategy chart (strategy.js) with zero deviation.
// Tracks a hidden cut card like a real casino shoe, and a Hi-Lo running/true
// count purely for display — the count is never consulted by getRecommendation.

const RESULT_TEXT = {
  win: 'Win',
  lose: 'Lose',
  push: 'Push',
  blackjack: 'Blackjack!',
  surrender: 'Surrender',
};

let lastRecords = [];
let simRunning = false;

function newShoeState(numDecks) {
  const cards = makeShoe(numDecks);
  const total = cards.length;
  // Real casino penetration: cut card placed so 72-85% of the shoe gets dealt.
  const penetration = 0.72 + Math.random() * 0.13;
  const cutRemaining = Math.max(Math.round(numDecks * 13), Math.round(total * (1 - penetration)));
  return {
    cards,
    total,
    cutRemaining,
    runningCount: 0,
    cutCardReached: false,
    needsReshuffle: false,
  };
}

function drawFromShoe(state) {
  const card = state.cards.pop();
  state.runningCount += hiLoValue(card);
  if (!state.cutCardReached && state.cards.length <= state.cutRemaining) {
    state.cutCardReached = true;
    state.needsReshuffle = true; // finish the current hand, reshuffle before the next
  }
  return card;
}

function trueCountOf(state) {
  const decksRemaining = Math.max(state.cards.length / 52, 0.25);
  return state.runningCount / decksRemaining;
}

// Draws a handful of cards to represent other players/dealer activity at the
// table while we're "wonged out" (sitting the shoe out). Advances the shoe
// and the count without creating a hand for us.
function drawGhostRound(state) {
  const n = 4 + Math.floor(Math.random() * 4); // 4-7 cards, roughly one round
  for (let i = 0; i < n && state.cards.length > 0; i++) {
    drawFromShoe(state);
  }
}

// A representative subset of the "Illustrious 18" index plays: departures
// from basic strategy that only pay off once the true count crosses a
// threshold. Only entries where our chart's base call actually differs from
// the deviation are listed (several Illustrious 18 plays already match this
// chart's default, so there'd be nothing to deviate to).
const DEVIATIONS = [
  { kind: 'hard', total: 16, dealer: '10', tc: 0, action: 'S' },
  { kind: 'hard', total: 15, dealer: '10', tc: 4, action: 'S' },
  { kind: 'hard', total: 16, dealer: '9', tc: 5, action: 'S' },
  { kind: 'hard', total: 10, dealer: '10', tc: 4, action: 'D' },
  { kind: 'hard', total: 10, dealer: 'A', tc: 4, action: 'D' },
  { kind: 'hard', total: 9, dealer: '2', tc: 1, action: 'D' },
  { kind: 'hard', total: 9, dealer: '7', tc: 3, action: 'D' },
  { kind: 'pair', rank: 10, dealer: '5', tc: 5, action: 'P' },
  { kind: 'pair', rank: 10, dealer: '6', tc: 4, action: 'P' },
];
const INSURANCE_TC_THRESHOLD = 3;

function normalizeDealerRank(rank) {
  return (rank === 'J' || rank === 'Q' || rank === 'K') ? '10' : rank;
}

function applyDeviations(rec, shape, dealerUpRank, tc, legal) {
  const dealerNorm = normalizeDealerRank(dealerUpRank);
  for (const dev of DEVIATIONS) {
    if (tc < dev.tc || dev.dealer !== dealerNorm) continue;
    if (dev.kind === 'pair') {
      if (!shape.isPair || shape.pairRank !== dev.rank) continue;
    } else {
      if (shape.isPair || shape.isSoft || shape.hardTotal !== dev.total) continue;
    }
    if (!legal[dev.action]) continue;
    return { action: dev.action, actionName: ACTION_NAMES[dev.action], deviated: true };
  }
  return rec;
}

function legalActionsSim(hand, numHandsInPlay, bankroll) {
  const isFirstTwo = hand.cards.length === 2;
  return {
    H: true,
    S: true,
    D: isFirstTwo && bankroll >= hand.bet,
    P: isFirstTwo && cardPairRank(hand.cards[0]) === cardPairRank(hand.cards[1]) && numHandsInPlay === 1 && bankroll >= hand.bet && !hand.fromSplitAces,
    R: isFirstTwo && numHandsInPlay === 1 && !hand.isSplitHand,
  };
}

function handShapeSim(hand) {
  const ev = evaluateHand(hand.cards);
  const pair = hand.cards.length === 2 && cardPairRank(hand.cards[0]) === cardPairRank(hand.cards[1]);
  return {
    isPair: pair,
    pairRank: pair ? cardPairRank(hand.cards[0]) : null,
    isSoft: ev.isSoft,
    softAceTotal: ev.isSoft ? ev.total - 11 : null,
    hardTotal: ev.total,
  };
}

function settleHandsSim(playerHands, dealerHand, bankroll) {
  const dEval = evaluateHand(dealerHand);
  for (const hand of playerHands) {
    if (hand.surrendered) { hand.result = 'surrender'; continue; }
    const pEval = evaluateHand(hand.cards);
    if (pEval.isBust) { hand.result = 'lose'; continue; }
    if (pEval.isBlackjack && !hand.isSplitHand) {
      if (dEval.isBlackjack) { hand.result = 'push'; bankroll += hand.bet; }
      else { hand.result = 'blackjack'; bankroll += hand.bet + Math.floor(hand.bet * 1.5); }
      continue;
    }
    if (dEval.isBust) { hand.result = 'win'; bankroll += hand.bet * 2; continue; }
    if (dEval.isBlackjack) { hand.result = 'lose'; continue; }
    if (pEval.total > dEval.total) { hand.result = 'win'; bankroll += hand.bet * 2; }
    else if (pEval.total < dEval.total) { hand.result = 'lose'; }
    else { hand.result = 'push'; bankroll += hand.bet; }
  }
  return bankroll;
}

function playHandAuto(state, bankroll, betAmount, handNumber, shoeNumber, deviationsOn) {
  const bankrollStart = bankroll;
  const rcAtStart = state.runningCount;
  const tcAtStart = trueCountOf(state);

  bankroll -= betAmount;
  const dealerHand = [drawFromShoe(state), drawFromShoe(state)];
  let playerHands = [{
    cards: [drawFromShoe(state), drawFromShoe(state)],
    bet: betAmount, done: false, doubled: false, surrendered: false,
    isSplitHand: false, fromSplitAces: false, result: null,
  }];
  const dealerUp = dealerHand[0].rank;

  // Insurance: only offered when the dealer shows an ace. A real counter
  // only takes it at a high enough true count, since it's a losing bet on
  // average otherwise.
  let insuranceNet = 0;
  if (deviationsOn && dealerUp === 'A' && tcAtStart >= INSURANCE_TC_THRESHOLD) {
    const insuranceCost = Math.floor(betAmount / 2);
    if (bankroll >= insuranceCost) {
      if (evaluateHand(dealerHand).isBlackjack) {
        insuranceNet = insuranceCost * 2;
      } else {
        insuranceNet = -insuranceCost;
      }
      bankroll += insuranceNet;
    }
  }

  const pEval0 = evaluateHand(playerHands[0].cards);
  const dEval0 = evaluateHand(dealerHand);

  if (!(pEval0.isBlackjack || dEval0.isBlackjack)) {
    let idx = 0;
    while (idx < playerHands.length) {
      let hand = playerHands[idx];
      while (!hand.done) {
        const legal = legalActionsSim(hand, playerHands.length, bankroll);
        const shape = handShapeSim(hand);
        let rec = getRecommendation(shape, dealerUp, legal);
        if (deviationsOn) rec = applyDeviations(rec, shape, dealerUp, tcAtStart, legal);

        if (rec.action === 'H') {
          hand.cards.push(drawFromShoe(state));
          const ev = evaluateHand(hand.cards);
          if (ev.isBust || ev.total === 21) hand.done = true;
        } else if (rec.action === 'S') {
          hand.done = true;
        } else if (rec.action === 'D') {
          bankroll -= hand.bet;
          hand.bet *= 2;
          hand.doubled = true;
          hand.cards.push(drawFromShoe(state));
          hand.done = true;
        } else if (rec.action === 'P') {
          const wasAces = hand.cards[0].rank === 'A';
          const c1 = hand.cards[0], c2 = hand.cards[1];
          const handA = { cards: [c1, drawFromShoe(state)], bet: hand.bet, done: wasAces, doubled: false, surrendered: false, isSplitHand: true, fromSplitAces: wasAces, result: null };
          const handB = { cards: [c2, drawFromShoe(state)], bet: hand.bet, done: wasAces, doubled: false, surrendered: false, isSplitHand: true, fromSplitAces: wasAces, result: null };
          bankroll -= hand.bet;
          playerHands.splice(idx, 1, handA, handB);
          hand = playerHands[idx];
        } else if (rec.action === 'R') {
          hand.surrendered = true;
          hand.done = true;
          bankroll += Math.floor(hand.bet / 2);
        }
      }
      idx++;
    }
  }

  const anyLive = playerHands.some(h => {
    if (h.surrendered) return false;
    const ev = evaluateHand(h.cards);
    if (ev.isBust) return false;
    if (ev.isBlackjack && !h.isSplitHand) return false;
    return true;
  });

  if (anyLive) {
    let dEval = evaluateHand(dealerHand);
    while (dEval.total < 17) {
      dealerHand.push(drawFromShoe(state));
      dEval = evaluateHand(dealerHand);
    }
  }

  bankroll = settleHandsSim(playerHands, dealerHand, bankroll);

  const record = {
    hand: handNumber,
    shoeNumber,
    dealerCards: dealerHand,
    dealerTotal: evaluateHand(dealerHand).total,
    playerHands,
    bet: betAmount,
    net: bankroll - bankrollStart,
    bankrollAfter: bankroll,
    runningCount: rcAtStart,
    trueCount: tcAtStart,
    reshuffled: state.needsReshuffle,
    insuranceNet,
  };

  return { bankroll, record };
}

// Classic Hi-Lo bet spread: more units out as the true count climbs.
// This is the only thing "card counting mode" changes — strategy decisions
// never consult the count, only the bet size does.
function betForTrueCount(tc, baseBet) {
  let units;
  if (tc >= 5) units = 8;
  else if (tc >= 4) units = 6;
  else if (tc >= 3) units = 4;
  else if (tc >= 2) units = 2;
  else units = 1;
  return baseBet * units;
}

function nextBet(state, baseBet, countingMode) {
  return countingMode ? betForTrueCount(trueCountOf(state), baseBet) : baseBet;
}

// Sit out hands while the true count is below the wong-in threshold, letting
// the shoe advance (as if other players/the dealer were still dealing)
// without us betting. Mutates state in place; returns the current state and
// how many rounds we sat out.
function wongUntilFavorable(state, numDecks, wongThreshold, shoeNumber, reshuffles) {
  let skipped = 0;
  let guard = 0;
  while (trueCountOf(state) < wongThreshold && guard < 400) {
    if (state.needsReshuffle || state.cards.length < 15) {
      shoeNumber += 1;
      state = newShoeState(numDecks);
      reshuffles += 1;
    }
    drawGhostRound(state);
    skipped += 1;
    guard += 1;
  }
  return { state, shoeNumber, reshuffles, skipped };
}

function runFastSimulation(numHands, baseBet, startingBankroll, numDecks, countingMode, deviationsOn, wongOn, wongThreshold) {
  let shoeNumber = 1;
  let state = newShoeState(numDecks);
  let bankroll = startingBankroll;
  const records = [];
  let reshuffles = 0;
  let wongedOut = 0;
  let stoppedEarly = false;

  for (let i = 1; i <= numHands; i++) {
    if (state.needsReshuffle || state.cards.length < 15) {
      shoeNumber += 1;
      state = newShoeState(numDecks);
      reshuffles += 1;
    }
    if (wongOn) {
      const w = wongUntilFavorable(state, numDecks, wongThreshold, shoeNumber, reshuffles);
      state = w.state; shoeNumber = w.shoeNumber; reshuffles = w.reshuffles; wongedOut += w.skipped;
    }
    if (bankroll < baseBet) { stoppedEarly = true; break; }
    // If the spread calls for more than the bankroll can cover, fall back to the base unit.
    const bet = Math.min(nextBet(state, baseBet, countingMode), bankroll);
    const { bankroll: newBankroll, record } = playHandAuto(state, bankroll, bet, i, shoeNumber, deviationsOn);
    bankroll = newBankroll;
    records.push(record);
  }

  return { records, finalBankroll: bankroll, reshuffles, stoppedEarly, wongedOut };
}

// ---- Rendering ----

function fmtMoney(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n))}`;
}

function handSummary(hand, idx, multi) {
  const ev = evaluateHand(hand.cards);
  const prefix = multi ? `H${idx + 1}: ` : '';
  const total = hand.surrendered ? `${ev.total} (surr)` : `${ev.total}${ev.isBust ? ' bust' : ''}`;
  return `${prefix}${total}`;
}

function computeStats(records, startingBankroll) {
  const stats = {
    hands: records.length,
    wins: 0, losses: 0, pushes: 0, blackjacks: 0, surrenders: 0,
    finalBankroll: records.length ? records[records.length - 1].bankrollAfter : startingBankroll,
  };
  for (const r of records) {
    for (const h of r.playerHands) {
      if (h.result === 'win') stats.wins += 1;
      else if (h.result === 'lose') stats.losses += 1;
      else if (h.result === 'push') stats.pushes += 1;
      else if (h.result === 'blackjack') { stats.wins += 1; stats.blackjacks += 1; }
      else if (h.result === 'surrender') stats.surrenders += 1;
    }
  }
  const decided = stats.wins + stats.losses + stats.pushes;
  stats.winRate = decided ? Math.round((stats.wins / decided) * 1000) / 10 : 0;
  stats.net = stats.finalBankroll - startingBankroll;
  stats.avgBet = records.length ? records.reduce((sum, r) => sum + r.bet, 0) / records.length : 0;
  stats.insuranceNet = records.reduce((sum, r) => sum + (r.insuranceNet || 0), 0);
  return stats;
}

function renderStats(stats, reshuffles, wongedOut) {
  document.getElementById('stat-hands').textContent = stats.hands;
  document.getElementById('stat-wins').textContent = stats.wins;
  document.getElementById('stat-losses').textContent = stats.losses;
  document.getElementById('stat-pushes').textContent = stats.pushes;
  document.getElementById('stat-blackjacks').textContent = stats.blackjacks;
  document.getElementById('stat-surrenders').textContent = stats.surrenders;
  document.getElementById('stat-winrate').textContent = `${stats.winRate}%`;
  document.getElementById('stat-reshuffles').textContent = reshuffles;
  document.getElementById('stat-avgbet').textContent = fmtMoney(stats.avgBet);
  document.getElementById('stat-wonged').textContent = wongedOut || 0;
  const insEl = document.getElementById('stat-insurance');
  insEl.textContent = fmtMoney(stats.insuranceNet);
  insEl.style.color = stats.insuranceNet >= 0 ? 'var(--correct)' : 'var(--wrong)';
  document.getElementById('stat-bankroll').textContent = fmtMoney(stats.finalBankroll);
  const netEl = document.getElementById('stat-net');
  netEl.textContent = fmtMoney(stats.net);
  netEl.style.color = stats.net >= 0 ? 'var(--correct)' : 'var(--wrong)';
  document.getElementById('stat-grid').classList.remove('hidden');
}

function renderLogTable(records) {
  const MAX_ROWS = 1000;
  const body = document.getElementById('log-table-body');
  const note = document.getElementById('log-note');
  const toShow = records.length > MAX_ROWS ? records.slice(-MAX_ROWS) : records;

  if (records.length > MAX_ROWS) {
    note.textContent = `Showing the last ${MAX_ROWS} of ${records.length} hands. Export CSV for the full log.`;
  } else {
    note.textContent = `${records.length} hands recorded.`;
  }

  body.innerHTML = toShow.map(r => {
    const multi = r.playerHands.length > 1;
    const playerStr = r.playerHands.map((h, i) => handSummary(h, i, multi)).join(' / ');
    const resultStr = r.playerHands.map(h => RESULT_TEXT[h.result] || '—').join(' / ');
    return `<tr>
      <td>${r.hand}</td>
      <td>${r.shoeNumber}</td>
      <td>${playerStr}</td>
      <td>${r.dealerTotal}</td>
      <td>${resultStr}</td>
      <td>${fmtMoney(r.bet)}</td>
      <td class="${r.net >= 0 ? 'cell-pos' : 'cell-neg'}">${fmtMoney(r.net)}</td>
      <td>${fmtMoney(r.bankrollAfter)}</td>
      <td>${r.runningCount}</td>
      <td>${r.trueCount.toFixed(1)}</td>
    </tr>`;
  }).join('');

  document.getElementById('log-panel').classList.remove('hidden');
}

function exportCSV(records) {
  const header = ['Hand', 'Shoe', 'Player', 'Dealer Total', 'Result', 'Bet', 'Net', 'Bankroll After', 'Running Count', 'True Count'];
  const rows = records.map(r => {
    const multi = r.playerHands.length > 1;
    const playerStr = r.playerHands.map((h, i) => handSummary(h, i, multi)).join(' | ');
    const resultStr = r.playerHands.map(h => RESULT_TEXT[h.result] || '').join(' | ');
    return [r.hand, r.shoeNumber, playerStr, r.dealerTotal, resultStr, r.bet, r.net, r.bankrollAfter, r.runningCount, r.trueCount.toFixed(2)];
  });
  const csv = [header, ...rows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `blackjack-simulation-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function cardHTML(card, hidden) {
  if (hidden) return `<div class="card back card-deal"></div>`;
  const red = card.suit === '♥' || card.suit === '♦';
  return `<div class="card ${red ? 'red' : 'black'} card-deal"><span class="rank">${card.rank}</span><span class="suit">${card.suit}</span></div>`;
}

function updateLiveCounts(state, upcomingBet) {
  document.getElementById('cards-left').textContent = state.cards.length;
  document.getElementById('running-count').textContent = state.runningCount;
  document.getElementById('true-count').textContent = trueCountOf(state).toFixed(1);
  document.getElementById('cut-status').textContent = state.cutCardReached ? 'passed' : 'in shoe';
  if (upcomingBet !== undefined) {
    document.getElementById('live-bet').textContent = fmtMoney(upcomingBet);
  }
}

function updateLiveHand(record, shoeNumber, revealDealer) {
  document.getElementById('shoe-number').textContent = shoeNumber;
  document.getElementById('live-dealer-cards').innerHTML = record.dealerCards
    .map((c, i) => cardHTML(c, !revealDealer && i === 1)).join('');

  const dealerTotalEl = document.getElementById('live-dealer-total');
  if (revealDealer) {
    dealerTotalEl.textContent = `(${record.dealerTotal})`;
  } else {
    const v = rankValue(record.dealerCards[0].rank);
    dealerTotalEl.textContent = `(${v === 11 ? '11' : v} showing)`;
  }

  const multi = record.playerHands.length > 1;
  document.getElementById('live-player-cards').innerHTML = record.playerHands
    .map(h => h.cards.map(c => cardHTML(c, false)).join('')).join('<span class="hand-gap"></span>');
  const totals = record.playerHands.map(h => evaluateHand(h.cards).total).join(' / ');
  document.getElementById('live-player-total').textContent = `(${totals})`;

  if (revealDealer) {
    const resultStr = record.playerHands.map((h, i) => `${multi ? `H${i + 1} ` : ''}${RESULT_TEXT[h.result] || ''}`).join(' · ');
    document.getElementById('live-hand-label').textContent = `Hand #${record.hand} — ${resultStr}`;
  } else {
    document.getElementById('live-hand-label').textContent = `Hand #${record.hand} — playing…`;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runLiveSimulation(numHands, baseBet, startingBankroll, numDecks, countingMode, deviationsOn, wongOn, wongThreshold) {
  const liveTable = document.getElementById('live-table');
  liveTable.classList.remove('hidden');
  document.getElementById('live-bet-chip').classList.toggle('hidden', !countingMode);

  let shoeNumber = 1;
  let state = newShoeState(numDecks);
  let bankroll = startingBankroll;
  const records = [];
  let reshuffles = 0;
  let wongedOut = 0;
  let stoppedEarly = false;

  for (let i = 1; i <= numHands; i++) {
    if (state.needsReshuffle || state.cards.length < 15) {
      shoeNumber += 1;
      state = newShoeState(numDecks);
      reshuffles += 1;
    }
    if (wongOn) {
      document.getElementById('live-hand-label').textContent = 'Wonging out — waiting for a favorable count…';
      const w = wongUntilFavorable(state, numDecks, wongThreshold, shoeNumber, reshuffles);
      state = w.state; shoeNumber = w.shoeNumber; reshuffles = w.reshuffles; wongedOut += w.skipped;
      updateLiveCounts(state);
    }
    if (bankroll < baseBet) { stoppedEarly = true; break; }
    const bet = Math.min(nextBet(state, baseBet, countingMode), bankroll);

    updateLiveCounts(state, bet);
    await sleep(140);

    const { bankroll: newBankroll, record } = playHandAuto(state, bankroll, bet, i, shoeNumber, deviationsOn);
    bankroll = newBankroll;
    records.push(record);

    updateLiveHand(record, shoeNumber, false);
    updateLiveCounts(state, bet);
    await sleep(320);

    updateLiveHand(record, shoeNumber, true);
    renderStats(computeStats(records, startingBankroll), reshuffles, wongedOut);
    renderLogTable(records);

    await sleep(220);
  }

  return { records, finalBankroll: bankroll, reshuffles, stoppedEarly, wongedOut };
}

async function handleRun() {
  if (simRunning) return;
  simRunning = true;
  const runBtn = document.getElementById('run-btn');
  runBtn.disabled = true;
  runBtn.textContent = 'Running…';

  const numHandsInput = parseInt(document.getElementById('num-hands').value, 10) || 0;
  const bet = Math.max(1, parseInt(document.getElementById('sim-bet').value, 10) || 25);
  const startingBankroll = Math.max(1, parseInt(document.getElementById('sim-bankroll').value, 10) || 1000);
  const numDecks = Math.min(8, Math.max(1, parseInt(document.getElementById('sim-decks').value, 10) || 6));
  const mode = document.getElementById('sim-mode').value;
  const countingMode = document.getElementById('counting-mode').checked;
  const deviationsOn = document.getElementById('deviation-mode').checked;
  const wongOn = document.getElementById('wong-mode').checked;
  const wongThreshold = parseFloat(document.getElementById('wong-threshold').value) || 1;

  let result;
  if (mode === 'live') {
    const numHands = Math.min(numHandsInput, 300);
    result = await runLiveSimulation(numHands, bet, startingBankroll, numDecks, countingMode, deviationsOn, wongOn, wongThreshold);
  } else {
    document.getElementById('live-table').classList.add('hidden');
    result = runFastSimulation(numHandsInput, bet, startingBankroll, numDecks, countingMode, deviationsOn, wongOn, wongThreshold);
    const stats = computeStats(result.records, startingBankroll);
    renderStats(stats, result.reshuffles, result.wongedOut);
    renderLogTable(result.records);
  }

  if (result.stoppedEarly) {
    const note = document.getElementById('log-note');
    note.textContent = `Bankroll ran out before all requested hands were played. ${note.textContent}`;
  }

  lastRecords = result.records;
  document.getElementById('export-btn').disabled = lastRecords.length === 0;

  runBtn.disabled = false;
  runBtn.textContent = 'Run Simulation';
  simRunning = false;
}

document.getElementById('run-btn').addEventListener('click', handleRun);
document.getElementById('export-btn').addEventListener('click', () => exportCSV(lastRecords));
document.getElementById('counting-mode').addEventListener('change', (e) => {
  document.getElementById('spread-table').classList.toggle('hidden', !e.target.checked);
});
