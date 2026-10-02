// Serverless multiplayer blackjack. Uses PeerJS (WebRTC) with its free public
// broker purely to introduce two browsers to each other — every card, bet,
// and move after that travels directly peer-to-peer. No backend of ours is
// involved, so this works as a static site (e.g. GitHub Pages).
//
// Topology: star, with the table creator as host. The host runs the only
// authoritative copy of game state and broadcasts it after every change;
// everyone else (including the host's own UI) just renders the latest state
// they were sent. No split in multiplayer — only hit/stand/double/surrender —
// to keep cross-network turn handling tractable.

let peer = null;
let isHost = false;
let selfId = null;
let hostConn = null; // client-side: connection to the host
let connections = {}; // host-side: peerId -> DataConnection
let shoe = [];
let discardCount = 0;
let game = null;
let myName = 'Player';
let roomCode = '';
let pendingBet = 0;
let lastSeenRound = -1;

const MP_DEAL_DELAY_MS = 260;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const RESULT_TEXT_MP = {
  win: 'Win', lose: 'Lose', push: 'Push', blackjack: 'Blackjack!', surrender: 'Surrendered',
};

// Plain digits — easier to read aloud or type on a phone than mixed letters.
function randomRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// ---- Host-side game engine ----

function ensureShoe() {
  if (shoe.length < 15) {
    shoe = makeShoe(6);
    discardCount = 0;
  }
}

function drawCard() {
  ensureShoe();
  return shoe.pop();
}

// Draws one card onto the given array, then broadcasts and pauses so every
// client sees cards arrive one at a time, flying in from the shoe.
async function dealOneCardMP(targetArray) {
  targetArray.push(drawCard());
  broadcastState();
  await sleep(MP_DEAL_DELAY_MS);
}

function hostInit(name) {
  game = {
    phase: 'betting',
    dealerCards: [],
    order: [],
    turnIdx: -1,
    players: {},
    roundNum: 0,
    hostId: selfId,
  };
  shoe = makeShoe(6);
  discardCount = 0;
  game.shoeCount = shoe.length;
  game.discardCount = discardCount;
  addPlayerToGame(selfId, name);
}

function addPlayerToGame(peerId, name) {
  if (game.players[peerId]) { game.players[peerId].connected = true; return true; }
  if (Object.keys(game.players).length >= 6) return false;
  game.players[peerId] = {
    name: (name || 'Player').slice(0, 16),
    bankroll: 1000,
    bet: 0,
    cards: [],
    done: false,
    doubled: false,
    surrendered: false,
    result: null,
    betReady: false,
    connected: true,
  };
  return true;
}

function removePlayerFromGame(peerId) {
  const p = game.players[peerId];
  if (!p) return;
  p.connected = false;
  if (game.phase === 'turns' && game.order[game.turnIdx] === peerId) {
    p.done = true;
    advanceTurn();
  }
}

function onPeerDisconnect(peerId) {
  if (!game) return;
  if (game.phase === 'betting') {
    delete game.players[peerId];
  } else {
    removePlayerFromGame(peerId);
  }
  broadcastState();
}

function legalMovesFor(p) {
  const isFirstTwo = p.cards.length === 2;
  return {
    H: true,
    S: true,
    D: isFirstTwo && p.bankroll >= p.bet,
    R: isFirstTwo,
  };
}

function maybeStartRound() {
  const ids = Object.keys(game.players).filter(id => game.players[id].connected);
  if (ids.length === 0) return;
  const allReady = ids.every(id => game.players[id].betReady);
  if (allReady) dealRound();
}

async function dealRound() {
  game.roundNum += 1;
  game.phase = 'dealing';
  for (const id of Object.keys(game.players)) {
    const p = game.players[id];
    p.cards = [];
    p.done = p.bet <= 0;
    p.doubled = false;
    p.surrendered = false;
    p.result = null;
  }

  const activeIds = Object.keys(game.players).filter(id => game.players[id].connected && game.players[id].bet > 0);
  if (activeIds.length === 0) {
    game.phase = 'betting';
    broadcastState();
    return;
  }

  ensureShoe();
  game.dealerCards = [];
  for (const id of activeIds) game.players[id].cards = [];
  game.order = activeIds;
  game.turnIdx = -1;
  for (const id of activeIds) game.players[id].bankroll -= game.players[id].bet;
  broadcastState();

  // Classic deal order: one card to each player, then the dealer, twice
  // (dealer's second card stays hidden client-side until it's revealed).
  for (const id of activeIds) await dealOneCardMP(game.players[id].cards);
  await dealOneCardMP(game.dealerCards);
  for (const id of activeIds) await dealOneCardMP(game.players[id].cards);
  await dealOneCardMP(game.dealerCards);

  game.phase = 'turns';

  for (const id of activeIds) {
    if (evaluateHand(game.players[id].cards).isBlackjack) game.players[id].done = true;
  }

  if (evaluateHand(game.dealerCards).isBlackjack) {
    await settleRound();
    return;
  }

  advanceTurn();
}

async function advanceTurn() {
  let i = game.turnIdx + 1;
  while (i < game.order.length) {
    const id = game.order[i];
    if (!game.players[id].done) {
      game.turnIdx = i;
      broadcastState();
      return;
    }
    i++;
  }
  game.turnIdx = -1;
  await dealerPlay();
}

function applyMove(peerId, action) {
  const p = game.players[peerId];
  if (!p || p.done) return;
  const legal = legalMovesFor(p);

  if (action === 'hit' && legal.H) {
    p.cards.push(drawCard());
    const ev = evaluateHand(p.cards);
    if (ev.isBust || ev.total === 21) { p.done = true; advanceTurn(); } else { broadcastState(); }
  } else if (action === 'stand' && legal.S) {
    p.done = true;
    advanceTurn();
  } else if (action === 'double' && legal.D) {
    p.bankroll -= p.bet;
    p.bet *= 2;
    p.doubled = true;
    p.cards.push(drawCard());
    p.done = true;
    advanceTurn();
  } else if (action === 'surrender' && legal.R) {
    p.surrendered = true;
    p.done = true;
    p.bankroll += Math.floor(p.bet / 2);
    advanceTurn();
  }
}

async function dealerPlay() {
  game.phase = 'dealer';
  broadcastState(); // reveal the hole card before any further draws
  const anyLive = game.order.some(id => {
    const p = game.players[id];
    if (p.surrendered) return false;
    return !evaluateHand(p.cards).isBust;
  });
  if (anyLive) {
    let dEval = evaluateHand(game.dealerCards);
    while (dEval.total < 17) {
      await dealOneCardMP(game.dealerCards);
      dEval = evaluateHand(game.dealerCards);
    }
  }
  settleRound();
}

function settleRound() {
  const dEval = evaluateHand(game.dealerCards);
  for (const id of game.order) {
    const p = game.players[id];
    if (p.surrendered) { p.result = 'surrender'; continue; }
    const ev = evaluateHand(p.cards);
    if (ev.isBust) { p.result = 'lose'; continue; }
    if (ev.isBlackjack) {
      if (dEval.isBlackjack) { p.result = 'push'; p.bankroll += p.bet; }
      else { p.result = 'blackjack'; p.bankroll += p.bet + Math.floor(p.bet * 1.5); }
      continue;
    }
    if (dEval.isBust) { p.result = 'win'; p.bankroll += p.bet * 2; continue; }
    if (dEval.isBlackjack) { p.result = 'lose'; continue; }
    if (ev.total > dEval.total) { p.result = 'win'; p.bankroll += p.bet * 2; }
    else if (ev.total < dEval.total) { p.result = 'lose'; }
    else { p.result = 'push'; p.bankroll += p.bet; }
  }
  discardCount += game.dealerCards.length + game.order.reduce((sum, id) => sum + game.players[id].cards.length, 0);
  game.phase = 'settled';
  broadcastState();
}

function hostStartBetting() {
  game.phase = 'betting';
  game.dealerCards = [];
  game.order = [];
  game.turnIdx = -1;
  for (const id of Object.keys(game.players)) {
    const p = game.players[id];
    p.bet = 0;
    p.betReady = false;
    p.cards = [];
    p.done = false;
    p.doubled = false;
    p.surrendered = false;
    p.result = null;
  }
  broadcastState();
}

function hostHandleMessage(peerId, msg) {
  if (msg.type === 'join') {
    addPlayerToGame(peerId, msg.name);
    broadcastState();
  } else if (msg.type === 'bet') {
    if (game.phase !== 'betting') return;
    const p = game.players[peerId];
    if (!p) return;
    p.bet = Math.max(0, Math.min(Math.floor(msg.amount) || 0, p.bankroll));
    p.betReady = true;
    broadcastState();
    maybeStartRound();
  } else if (msg.type === 'move') {
    if (game.phase !== 'turns') return;
    if (game.order[game.turnIdx] !== peerId) return;
    applyMove(peerId, msg.action);
  }
}

function broadcastState() {
  game.shoeCount = shoe.length;
  game.discardCount = discardCount;
  const payload = { type: 'state', state: game };
  for (const id in connections) {
    try { connections[id].send(payload); } catch (e) { /* peer likely gone; disconnect handler will clean up */ }
  }
  renderAll();
}

// ---- Networking ----

function createTable() {
  myName = (document.getElementById('player-name').value || 'Player').trim().slice(0, 16) || 'Player';
  roomCode = (document.getElementById('room-code-input').value || '').trim() || randomRoomCode();
  document.getElementById('lobby-status').textContent = 'Creating table…';

  peer = new Peer(roomCode, { debug: 1 });
  peer.on('open', (id) => {
    selfId = id;
    isHost = true;
    hostInit(myName);
    showTable();
    renderAll();
  });
  peer.on('connection', (conn) => {
    connections[conn.peer] = conn;
    conn.on('data', (msg) => hostHandleMessage(conn.peer, msg));
    conn.on('close', () => {
      delete connections[conn.peer];
      onPeerDisconnect(conn.peer);
    });
  });
  peer.on('error', (err) => {
    const friendly = err.type === 'unavailable-id' ? 'That room code is taken — try another.' : err.message;
    document.getElementById('lobby-status').textContent = `Error: ${friendly}`;
  });
}

function joinTable() {
  myName = (document.getElementById('player-name').value || 'Player').trim().slice(0, 16) || 'Player';
  roomCode = (document.getElementById('room-code-input').value || '').trim();
  if (!roomCode) {
    document.getElementById('lobby-status').textContent = 'Enter a room code to join.';
    return;
  }
  document.getElementById('lobby-status').textContent = 'Connecting…';

  peer = new Peer({ debug: 1 });
  peer.on('open', (id) => {
    selfId = id;
    isHost = false;
    hostConn = peer.connect(roomCode, { reliable: true });
    hostConn.on('open', () => {
      hostConn.send({ type: 'join', name: myName });
      showTable();
    });
    hostConn.on('data', (msg) => {
      if (msg.type === 'state') { game = msg.state; renderAll(); }
    });
    hostConn.on('close', () => {
      document.getElementById('lobby-status').textContent = 'Host disconnected — table closed.';
      leaveTable(true);
    });
  });
  peer.on('error', (err) => {
    const friendly = err.type === 'peer-unavailable' ? 'No table found with that code.' : err.message;
    document.getElementById('lobby-status').textContent = `Error: ${friendly}`;
  });
}

function sendToHost(msg) {
  if (isHost) hostHandleMessage(selfId, msg);
  else if (hostConn) hostConn.send(msg);
}

function leaveTable(hostClosed) {
  try { if (hostConn) hostConn.close(); } catch (e) { /* already closed */ }
  try { if (peer) peer.destroy(); } catch (e) { /* already destroyed */ }
  peer = null; hostConn = null; connections = {}; game = null; isHost = false; selfId = null;
  pendingBet = 0; lastSeenRound = -1;
  document.getElementById('mp-table-wrap').classList.add('hidden');
  document.getElementById('lobby-panel').classList.remove('hidden');
  if (!hostClosed) document.getElementById('lobby-status').textContent = '';
}

function showTable() {
  document.getElementById('lobby-panel').classList.add('hidden');
  document.getElementById('mp-table-wrap').classList.remove('hidden');
  document.getElementById('room-code-display').textContent = roomCode;
}

// ---- Local strategy coach (client-side only, purely informational) ----

function showSnackbarMP(title, message, type) {
  const container = document.getElementById('snackbar-container');
  const bar = document.createElement('div');
  bar.className = `snackbar ${type}`;
  bar.innerHTML = `<span class="snackbar-title">${escapeHtml(title)}</span><span class="snackbar-body">${escapeHtml(message)}</span>`;
  container.appendChild(bar);
  requestAnimationFrame(() => bar.classList.add('show'));
  setTimeout(() => {
    bar.classList.remove('show');
    bar.addEventListener('transitionend', () => bar.remove(), { once: true });
  }, 6000);
}

function mpJudgeDecision(actionTaken, me) {
  const dealerUp = game.dealerCards[0].rank;
  const legal = legalMovesFor(me);
  const ev = evaluateHand(me.cards);
  const shape = { isPair: false, pairRank: null, isSoft: ev.isSoft, softAceTotal: ev.isSoft ? ev.total - 11 : null, hardTotal: ev.total };
  const rec = getRecommendation(shape, dealerUp, legal);
  const codeFor = { hit: 'H', stand: 'S', double: 'D', surrender: 'R' };
  const taken = codeFor[actionTaken];
  const correct = rec.action === taken;
  const handLabel = shape.isSoft ? `Soft ${shape.hardTotal} (A,${shape.softAceTotal})` : `Hard ${shape.hardTotal}`;
  const dealerLabel = ['J', 'Q', 'K'].includes(dealerUp) ? '10' : dealerUp;
  if (correct) {
    showSnackbarMP('Correct', `${handLabel} vs dealer ${dealerLabel}: basic strategy says ${rec.actionName}.`, 'correct');
  } else {
    showSnackbarMP('Not quite', `${handLabel} vs dealer ${dealerLabel}: basic strategy says ${rec.actionName} instead of ${ACTION_NAMES[taken]}.`, 'wrong');
  }
}

// ---- Rendering ----

let mpLastDealerCount = 0;
let mpLastHandCounts = {};
let mpDealerHoleWasHidden = true;
let mpLastRoundNum = -1;

function cardHTML(card, hidden, isNew, isFlip) {
  const dealAttr = isNew ? 'data-deal="1"' : '';
  const flipClass = isFlip ? 'card-flip' : '';
  if (hidden) return `<div class="card back ${flipClass}" ${dealAttr}></div>`;
  const red = card.suit === '♥' || card.suit === '♦';
  return `<div class="card ${red ? 'red' : 'black'} ${flipClass}" ${dealAttr}><span class="rank">${card.rank}</span><span class="suit">${card.suit}</span></div>`;
}

// Flies each newly dealt card in from the shoe's actual on-screen position.
function animateDealtCardsMP() {
  const deckEl = document.getElementById('shoe-visual');
  if (!deckEl) return;
  const deckRect = deckEl.getBoundingClientRect();
  const deckCenter = { x: deckRect.left + deckRect.width / 2, y: deckRect.top + deckRect.height / 2 };

  document.querySelectorAll('[data-deal="1"]').forEach(el => {
    const cardRect = el.getBoundingClientRect();
    const cardCenter = { x: cardRect.left + cardRect.width / 2, y: cardRect.top + cardRect.height / 2 };
    const dx = deckCenter.x - cardCenter.x;
    const dy = deckCenter.y - cardCenter.y;
    el.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(0.5) rotate(-12deg)`, opacity: 0.3 },
      { transform: 'translate(0, 0) scale(1) rotate(0deg)', opacity: 1 },
    ], { duration: 240, easing: 'cubic-bezier(.21,.68,.33,1.02)' });
    el.removeAttribute('data-deal');
  });
}

function updateMpDeckCounts() {
  const shoeCountEl = document.getElementById('shoe-count');
  const discardCountEl = document.getElementById('discard-count');
  const discardVisual = document.getElementById('discard-visual');
  if (shoeCountEl) shoeCountEl.textContent = game.shoeCount ?? '';
  if (discardCountEl) discardCountEl.textContent = game.discardCount ?? 0;
  if (discardVisual) discardVisual.classList.toggle('hidden', !game.discardCount);
}

function renderDealer() {
  const hideHole = game.phase === 'betting' || game.phase === 'dealing' || game.phase === 'turns';
  const cardsEl = document.getElementById('mp-dealer-cards');
  cardsEl.innerHTML = (game.dealerCards || []).map((c, i) => {
    const isFlip = i === 1 && mpDealerHoleWasHidden && !hideHole;
    return cardHTML(c, hideHole && i === 1, i >= mpLastDealerCount, isFlip);
  }).join('');
  mpLastDealerCount = (game.dealerCards || []).length;
  mpDealerHoleWasHidden = hideHole;

  const totalEl = document.getElementById('mp-dealer-total');
  if (!game.dealerCards || game.dealerCards.length === 0) {
    totalEl.textContent = '';
  } else if (hideHole) {
    const v = rankValue(game.dealerCards[0].rank);
    totalEl.textContent = `(${v === 11 ? '11' : v} showing)`;
  } else {
    const ev = evaluateHand(game.dealerCards);
    totalEl.textContent = `(${ev.total}${ev.isBust ? ' — Bust' : ''})`;
  }
}

// Positions seats along the lower rim of the oval table, as if looking
// straight down at players sitting around it.
function seatPosition(i, n) {
  const t = n <= 1 ? 0.5 : i / (n - 1);
  const left = 12 + t * 76; // 12% - 88% across
  const top = 18 + Math.sin(t * Math.PI) * 64; // dips lowest in the middle
  return { left, top };
}

function renderSeats() {
  const container = document.getElementById('mp-seats');
  const ids = Object.keys(game.players);
  container.innerHTML = ids.map((id, idx) => {
    const p = game.players[id];
    const hasCards = p.cards && p.cards.length > 0;
    const ev = hasCards ? evaluateHand(p.cards) : null;
    const isTurn = game.phase === 'turns' && game.order[game.turnIdx] === id;
    const isMe = id === selfId;

    let status = '';
    if (p.surrendered) status = ' — Surrendered';
    else if (hasCards && ev.isBust) status = ' — Bust';
    else if (hasCards && p.cards.length === 2 && ev.isBlackjack) status = ' — Blackjack!';
    if (game.phase === 'settled' && p.result) status = ` — ${RESULT_TEXT_MP[p.result]}`;
    if (!p.connected) status += ' (disconnected)';

    const prevCount = mpLastHandCounts[id] || 0;
    const cardsHTML = (p.cards || []).map((c, i) => cardHTML(c, false, i >= prevCount)).join('');
    mpLastHandCounts[id] = (p.cards || []).length;

    const pos = seatPosition(idx, ids.length);

    return `
      <div class="mp-seat ${isTurn ? 'active-hand' : ''} ${isMe ? 'mp-seat-me' : ''}" style="left:${pos.left}%; top:${pos.top}%;">
        <div class="mp-seat-name">${escapeHtml(p.name)}${isMe ? ' (you)' : ''}${escapeHtml(status)}</div>
        <div class="card-row">${cardsHTML}</div>
        <div class="mp-seat-footer">
          <span class="total-badge">${hasCards ? `(${ev.total}${ev.isSoft ? ' soft' : ''})` : ''}</span>
          <span class="hand-bet"><span class="hand-bet-chip"></span>$${p.bet}</span>
          <span class="mp-bankroll">$${p.bankroll}</span>
        </div>
      </div>`;
  }).join('');
}

function renderPhaseBanner() {
  const el = document.getElementById('mp-phase-banner');
  if (game.phase === 'settled') {
    el.textContent = 'Round settled.';
    el.classList.remove('hidden');
  } else if (game.phase === 'betting') {
    const waiting = Object.values(game.players).filter(p => p.connected && !p.betReady).map(p => p.name);
    el.textContent = waiting.length ? `Waiting on bets from: ${waiting.join(', ')}` : 'All bets in — dealing…';
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function updateMpActionAvailability(me) {
  const legal = legalMovesFor(me);
  document.getElementById('mp-hit-btn').disabled = !legal.H;
  document.getElementById('mp-stand-btn').disabled = !legal.S;
  document.getElementById('mp-double-btn').disabled = !legal.D;
  document.getElementById('mp-surrender-btn').disabled = !legal.R;
}

function renderControls() {
  const betWrap = document.getElementById('mp-bet-controls');
  const actionWrap = document.getElementById('mp-action-controls');
  const waitingNote = document.getElementById('mp-waiting-note');
  const hostNextBtn = document.getElementById('mp-host-next-btn');
  const me = game.players[selfId];

  betWrap.classList.add('hidden');
  actionWrap.classList.add('hidden');
  waitingNote.classList.add('hidden');
  hostNextBtn.classList.add('hidden');

  if (game.phase === 'betting' && game.roundNum !== lastSeenRound) {
    pendingBet = 0;
    lastSeenRound = game.roundNum;
    document.getElementById('mp-current-bet').textContent = '$0';
  }

  if (!me) return;

  if (game.phase === 'betting' && !me.betReady) {
    betWrap.classList.remove('hidden');
  } else if (game.phase === 'turns' && game.order[game.turnIdx] === selfId) {
    actionWrap.classList.remove('hidden');
    updateMpActionAvailability(me);
  } else if (game.phase === 'turns') {
    const curId = game.order[game.turnIdx];
    waitingNote.textContent = `Waiting on ${game.players[curId] ? game.players[curId].name : '…'}'s move…`;
    waitingNote.classList.remove('hidden');
  } else if (game.phase === 'settled') {
    if (isHost) {
      hostNextBtn.classList.remove('hidden');
    } else {
      waitingNote.textContent = 'Waiting for the host to deal the next round…';
      waitingNote.classList.remove('hidden');
    }
  } else if (game.phase === 'betting' && me.betReady) {
    waitingNote.textContent = 'Bet placed — waiting on other players…';
    waitingNote.classList.remove('hidden');
  }
}

function renderAll() {
  if (!game) return;
  if (game.roundNum !== mpLastRoundNum) {
    mpLastRoundNum = game.roundNum;
    mpLastDealerCount = 0;
    mpLastHandCounts = {};
    mpDealerHoleWasHidden = true;
  }
  const connectedCount = Object.values(game.players).filter(p => p.connected).length;
  document.getElementById('connection-status').textContent = `${connectedCount} player${connectedCount === 1 ? '' : 's'} connected`;
  renderDealer();
  renderSeats();
  renderPhaseBanner();
  renderControls();
  updateMpDeckCounts();
  animateDealtCardsMP();
}

// ---- UI wiring ----

document.getElementById('create-btn').addEventListener('click', createTable);
document.getElementById('join-btn').addEventListener('click', joinTable);
document.getElementById('leave-btn').addEventListener('click', () => leaveTable(false));

document.getElementById('copy-code-btn').addEventListener('click', () => {
  navigator.clipboard?.writeText(roomCode).catch(() => {});
});

document.querySelectorAll('#mp-bet-controls .chip-tray .chip').forEach(btn => {
  btn.addEventListener('click', () => {
    const val = parseInt(btn.dataset.chip, 10);
    const me = game && game.players[selfId];
    const bankroll = me ? me.bankroll : 1000;
    if (pendingBet + val <= bankroll) {
      pendingBet += val;
      document.getElementById('mp-current-bet').textContent = `$${pendingBet}`;
    }
  });
});

document.getElementById('mp-clear-bet').addEventListener('click', () => {
  pendingBet = 0;
  document.getElementById('mp-current-bet').textContent = '$0';
});

document.getElementById('mp-place-bet').addEventListener('click', () => {
  sendToHost({ type: 'bet', amount: pendingBet });
});

function mpAction(type) {
  const me = game && game.players[selfId];
  if (!me) return;
  mpJudgeDecision(type, me);
  sendToHost({ type: 'move', action: type });
}

document.getElementById('mp-hit-btn').addEventListener('click', () => mpAction('hit'));
document.getElementById('mp-stand-btn').addEventListener('click', () => mpAction('stand'));
document.getElementById('mp-double-btn').addEventListener('click', () => mpAction('double'));
document.getElementById('mp-surrender-btn').addEventListener('click', () => mpAction('surrender'));

document.getElementById('mp-host-next-btn').addEventListener('click', () => {
  if (isHost) hostStartBetting();
});
