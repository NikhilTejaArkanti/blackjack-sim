// Blackjack game engine + UI wiring. 6-deck shoe, dealer stands on all 17s,
// double after split allowed, single split (no resplit), blackjack pays 3:2.
// Card/deck primitives (SUITS, RANKS, rankValue, evaluateHand, cardPairRank,
// makeShoe) live in cards.js and are shared with the simulation page.

const NUM_DECKS = 6;

let shoe = [];
let bankroll = 1000;
let currentBet = 25;

let dealerHand = [];
let playerHands = []; // array of hand objects
let activeHandIndex = 0;
let roundActive = false;
let correctCount = 0;
let totalCount = 0;

function drawCard() {
  if (shoe.length < 20) {
    shoe = makeShoe(NUM_DECKS);
    log('— Shoe reshuffled —', 'info');
  }
  return shoe.pop();
}

function newPlayerHand(cards, bet) {
  return {
    cards,
    bet,
    done: false,
    doubled: false,
    surrendered: false,
    isSplitHand: false,
    fromSplitAces: false,
    result: null,
  };
}

function startRound() {
  if (currentBet <= 0) { alert('Place a bet first.'); return; }
  if (currentBet > bankroll) { alert('Bet exceeds bankroll.'); return; }

  bankroll -= currentBet;
  dealerHand = [drawCard(), drawCard()];
  playerHands = [newPlayerHand([drawCard(), drawCard()], currentBet)];
  activeHandIndex = 0;
  roundActive = true;
  lastDealerCount = 0;
  lastHandCounts = [];
  dealerHoleWasHidden = true;

  document.getElementById('result-banner').classList.add('hidden');
  document.getElementById('bet-controls').classList.add('hidden');
  document.getElementById('action-controls').classList.remove('hidden');
  document.getElementById('next-controls').classList.add('hidden');
  clearLog();

  render();

  const pEval = evaluateHand(playerHands[0].cards);
  const dEval = evaluateHand(dealerHand);
  if (pEval.isBlackjack || dEval.isBlackjack) {
    finishRound();
    return;
  }

  updateActionAvailability();
}

function currentHand() {
  return playerHands[activeHandIndex];
}

function legalActionsFor(hand) {
  const isFirstTwo = hand.cards.length === 2;
  return {
    H: true,
    S: true,
    D: isFirstTwo && bankroll >= hand.bet,
    P: isFirstTwo && isPair(hand) && playerHands.length === 1 && bankroll >= hand.bet && !hand.fromSplitAces,
    R: isFirstTwo && playerHands.length === 1 && !hand.isSplitHand,
  };
}

function isPair(hand) {
  return hand.cards.length === 2 && cardPairRank(hand.cards[0]) === cardPairRank(hand.cards[1]);
}

function handShape(hand) {
  const ev = evaluateHand(hand.cards);
  const pair = isPair(hand);
  return {
    isPair: pair,
    pairRank: pair ? cardPairRank(hand.cards[0]) : null,
    isSoft: ev.isSoft,
    softAceTotal: ev.isSoft ? ev.total - 11 : null,
    hardTotal: ev.total,
  };
}

function dealerUpRank() {
  return dealerHand[0].rank;
}

function judgeDecision(actionTaken) {
  const hand = currentHand();
  const legal = legalActionsFor(hand);
  const shape = handShape(hand);
  const rec = getRecommendation(shape, dealerUpRank(), legal);

  totalCount += 1;
  const correct = rec.action === actionTaken;
  if (correct) correctCount += 1;

  const handLabel = describeHand(shape);
  const dealerLabel = dealerUpRank() === '10' || ['J','Q','K'].includes(dealerUpRank()) ? '10' : dealerUpRank();

  if (correct) {
    const msg = `${handLabel} vs dealer ${dealerLabel}: basic strategy says ${rec.actionName}.`;
    log(`✔ Correct — ${msg}`, 'correct');
    showSnackbar('Correct', msg, 'correct');
  } else {
    const msg = `${handLabel} vs dealer ${dealerLabel}: basic strategy says ${rec.actionName} instead of ${ACTION_NAMES[actionTaken]}.`;
    log(`✘ ${ACTION_NAMES[actionTaken]} — ${handLabel} vs dealer ${dealerLabel}: basic strategy says ${rec.actionName} instead.`, 'wrong');
    showSnackbar('Not quite', msg, 'wrong');
  }
  updateAccuracy();
}

function describeHand(shape) {
  if (shape.isPair) {
    const name = shape.pairRank === 11 ? 'A' : shape.pairRank;
    return `${name},${name} pair`;
  }
  if (shape.isSoft) return `Soft ${shape.hardTotal} (A,${shape.softAceTotal})`;
  return `Hard ${shape.hardTotal}`;
}

function updateAccuracy() {
  const pct = totalCount ? Math.round((correctCount / totalCount) * 100) : 0;
  document.getElementById('accuracy-value').textContent = `${correctCount} / ${totalCount} (${pct}%)`;
}

function doHit() {
  const hand = currentHand();
  judgeDecision('H');
  hand.cards.push(drawCard());
  const ev = evaluateHand(hand.cards);
  render();
  if (ev.isBust || ev.total === 21) {
    advanceOrFinish();
  } else {
    updateActionAvailability();
  }
}

function doStand() {
  judgeDecision('S');
  currentHand().done = true;
  render();
  advanceOrFinish();
}

function doDouble() {
  const hand = currentHand();
  judgeDecision('D');
  bankroll -= hand.bet;
  hand.bet *= 2;
  hand.doubled = true;
  hand.cards.push(drawCard());
  hand.done = true;
  render();
  advanceOrFinish();
}

function doSplit() {
  const hand = currentHand();
  judgeDecision('P');
  const wasAces = hand.cards[0].rank === 'A';
  const card1 = hand.cards[0];
  const card2 = hand.cards[1];

  const handA = newPlayerHand([card1, drawCard()], hand.bet);
  const handB = newPlayerHand([card2, drawCard()], hand.bet);
  handA.isSplitHand = true;
  handB.isSplitHand = true;
  handA.fromSplitAces = wasAces;
  handB.fromSplitAces = wasAces;
  bankroll -= hand.bet; // second hand's bet

  if (wasAces) {
    handA.done = true;
    handB.done = true;
  }

  playerHands = [handA, handB];
  lastHandCounts = [0, 0];
  activeHandIndex = 0;
  render();

  if (wasAces) {
    advanceOrFinish();
  } else {
    updateActionAvailability();
  }
}

function doSurrender() {
  const hand = currentHand();
  judgeDecision('R');
  hand.surrendered = true;
  hand.done = true;
  bankroll += Math.floor(hand.bet / 2);
  render();
  advanceOrFinish();
}

function advanceOrFinish() {
  const hand = currentHand();
  hand.done = true;
  if (activeHandIndex < playerHands.length - 1) {
    activeHandIndex += 1;
    render();
    updateActionAvailability();
  } else {
    finishRound();
  }
}

function allHandsResolved() {
  return playerHands.every(h => h.surrendered || evaluateHand(h.cards).isBust || h.done);
}

function dealerShouldPlay() {
  return playerHands.some(h => {
    if (h.surrendered) return false;
    const ev = evaluateHand(h.cards);
    if (ev.isBust) return false;
    if (ev.isBlackjack && !h.isSplitHand) return false; // natural resolves instantly, no extra dealer draw needed
    return true;
  });
}

function finishRound() {
  roundActive = false;
  document.getElementById('action-controls').classList.add('hidden');

  if (dealerShouldPlay()) {
    let dEval = evaluateHand(dealerHand);
    while (dEval.total < 17) {
      dealerHand.push(drawCard());
      dEval = evaluateHand(dealerHand);
    }
  }

  settleBets();
  render(true);
  document.getElementById('next-controls').classList.remove('hidden');
}

function settleBets() {
  const dEval = evaluateHand(dealerHand);
  const messages = [];

  for (const hand of playerHands) {
    if (hand.surrendered) {
      hand.result = 'surrender';
      continue;
    }
    const pEval = evaluateHand(hand.cards);
    if (pEval.isBust) {
      hand.result = 'lose';
      continue;
    }
    if (pEval.isBlackjack && !hand.isSplitHand) {
      if (dEval.isBlackjack) {
        hand.result = 'push';
        bankroll += hand.bet;
      } else {
        hand.result = 'blackjack';
        bankroll += hand.bet + Math.floor(hand.bet * 1.5);
      }
      continue;
    }
    if (dEval.isBust) {
      hand.result = 'win';
      bankroll += hand.bet * 2;
      continue;
    }
    if (dEval.isBlackjack) {
      hand.result = 'lose';
      continue;
    }
    if (pEval.total > dEval.total) {
      hand.result = 'win';
      bankroll += hand.bet * 2;
    } else if (pEval.total < dEval.total) {
      hand.result = 'lose';
    } else {
      hand.result = 'push';
      bankroll += hand.bet;
    }
  }

  const RESULT_TEXT = {
    win: 'Win',
    lose: 'Lose',
    push: 'Push',
    blackjack: 'Blackjack!',
    surrender: 'Surrendered',
  };
  const summary = playerHands.map((h, i) => `Hand ${i + 1}: ${RESULT_TEXT[h.result]}`).join(' · ');
  const banner = document.getElementById('result-banner');
  banner.textContent = summary;
  banner.className = '';
  banner.classList.remove('hidden');
}

function updateActionAvailability() {
  const hand = currentHand();
  const legal = legalActionsFor(hand);
  document.getElementById('hit-btn').disabled = !legal.H;
  document.getElementById('stand-btn').disabled = !legal.S;
  document.getElementById('double-btn').disabled = !legal.D;
  document.getElementById('split-btn').disabled = !legal.P;
  document.getElementById('surrender-btn').disabled = !legal.R;
}

let lastDealerCount = 0;
let lastHandCounts = [];
let dealerHoleWasHidden = true;

function cardHTML(card, hidden, isNew, isFlip) {
  const animClass = isFlip ? 'card-flip' : (isNew ? 'card-deal' : '');
  if (hidden) return `<div class="card back ${animClass}"></div>`;
  const red = card.suit === '♥' || card.suit === '♦';
  return `<div class="card ${red ? 'red' : 'black'} ${animClass}"><span class="rank">${card.rank}</span><span class="suit">${card.suit}</span></div>`;
}

function render(revealDealer) {
  const dealerCardsEl = document.getElementById('dealer-cards');
  const hideHole = !revealDealer && roundActive;
  dealerCardsEl.innerHTML = dealerHand.map((c, i) => {
    const isFlip = i === 1 && dealerHoleWasHidden && !hideHole;
    return cardHTML(c, hideHole && i === 1, i >= lastDealerCount, isFlip);
  }).join('');
  lastDealerCount = dealerHand.length;
  dealerHoleWasHidden = hideHole;

  const dealerTotalEl = document.getElementById('dealer-total');
  if (hideHole) {
    dealerTotalEl.textContent = `(${rankValue(dealerHand[0].rank) === 11 ? '11' : rankValue(dealerHand[0].rank)} showing)`;
  } else {
    const dEval = evaluateHand(dealerHand);
    dealerTotalEl.textContent = `(${dEval.total}${dEval.isBust ? ' — Bust' : ''})`;
  }

  const handsContainer = document.getElementById('player-hands');
  handsContainer.innerHTML = playerHands.map((hand, idx) => {
    const ev = evaluateHand(hand.cards);
    const isActive = roundActive && idx === activeHandIndex;
    const label = playerHands.length > 1 ? `Hand ${idx + 1}` : 'Your Hand';
    let status = '';
    if (hand.surrendered) status = ' — Surrendered';
    else if (ev.isBust) status = ' — Bust';
    else if (ev.isBlackjack && !hand.isSplitHand) status = ' — Blackjack!';
    if (!roundActive && hand.result) {
      const RESULT_TEXT = { win: 'Win', lose: 'Lose', push: 'Push', blackjack: 'Blackjack!', surrender: 'Surrendered' };
      status = ` — ${RESULT_TEXT[hand.result]}`;
    }
    const prevCount = lastHandCounts[idx] || 0;
    const cardsHTML = hand.cards.map((c, i) => cardHTML(c, false, i >= prevCount)).join('');
    lastHandCounts[idx] = hand.cards.length;
    return `
      <div class="hand-block ${isActive ? 'active-hand' : ''}">
        <h3>${label} <span class="total-badge">(${ev.total}${ev.isSoft ? ' soft' : ''})</span>${status}</h3>
        <div class="card-row">${cardsHTML}</div>
        <div class="hand-bet"><span class="hand-bet-chip"></span>$${hand.bet}</div>
      </div>`;
  }).join('');
  lastHandCounts.length = playerHands.length;

  document.getElementById('bankroll').textContent = bankroll;
  document.getElementById('current-bet').textContent = currentBet;
}

function showSnackbar(title, message, type) {
  const container = document.getElementById('snackbar-container');
  const bar = document.createElement('div');
  bar.className = `snackbar ${type}`;
  bar.innerHTML = `<span class="snackbar-title">${title}</span><span class="snackbar-body">${message}</span>`;
  container.appendChild(bar);

  requestAnimationFrame(() => bar.classList.add('show'));

  setTimeout(() => {
    bar.classList.remove('show');
    bar.addEventListener('transitionend', () => bar.remove(), { once: true });
  }, 3200);
}

function log(message, type) {
  const el = document.getElementById('feedback-log');
  const line = document.createElement('div');
  line.className = `log-line ${type || ''}`;
  line.textContent = message;
  el.prepend(line);
}

function clearLog() {
  document.getElementById('feedback-log').innerHTML = '';
}

// ---- UI wiring ----

document.querySelectorAll('.chip-tray .chip').forEach(btn => {
  btn.addEventListener('click', () => {
    const val = parseInt(btn.dataset.chip, 10);
    if (currentBet + val <= bankroll) {
      currentBet += val;
      document.getElementById('current-bet').textContent = currentBet;
    }
  });
});

document.getElementById('clear-bet').addEventListener('click', () => {
  currentBet = 0;
  document.getElementById('current-bet').textContent = currentBet;
});

document.getElementById('deal-btn').addEventListener('click', startRound);
document.getElementById('hit-btn').addEventListener('click', doHit);
document.getElementById('stand-btn').addEventListener('click', doStand);
document.getElementById('double-btn').addEventListener('click', doDouble);
document.getElementById('split-btn').addEventListener('click', doSplit);
document.getElementById('surrender-btn').addEventListener('click', doSurrender);

document.getElementById('new-hand-btn').addEventListener('click', () => {
  document.getElementById('bet-controls').classList.remove('hidden');
  document.getElementById('next-controls').classList.add('hidden');
  if (currentBet > bankroll) currentBet = Math.min(25, bankroll);
  document.getElementById('current-bet').textContent = currentBet;
  document.getElementById('bankroll').textContent = bankroll;
});

const toggleTotalsEl = document.getElementById('toggle-totals');
document.body.classList.toggle('hide-totals', !toggleTotalsEl.checked);
toggleTotalsEl.addEventListener('change', () => {
  document.body.classList.toggle('hide-totals', !toggleTotalsEl.checked);
});

shoe = makeShoe(NUM_DECKS);
render();
updateAccuracy();
