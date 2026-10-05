// Card counting drill. Deals a shuffled shoe one card at a time at a chosen
// pace, then quizzes the player on the Hi-Lo running count and true count
// with four multiple-choice options each. Card/deck primitives (hiLoValue,
// makeShoe) live in cards.js and are shared with the other pages.

const PACE_DELAY_MS = { slow: 1600, medium: 900, fast: 450 };

let ccDeckCount = 6;
let ccPace = 'medium';
let ccShoe = [];
let ccDealt = [];
let ccRunningCount = 0;
let ccDealTimer = null;
let ccSessionCorrect = 0;
let ccSessionTotal = 0;
let ccAwaitingAnswer = null; // 'running' | 'true' | null

function ccCardHTML(card) {
  const red = card.suit === '♥' || card.suit === '♦';
  return `<div class="card ${red ? 'red' : 'black'} card-deal"><span class="rank">${card.rank}</span><span class="suit">${card.suit}</span></div>`;
}

function ccTrueCount() {
  const cardsRemaining = ccShoe.length;
  const decksRemaining = Math.max(cardsRemaining / 52, 0.25);
  return ccRunningCount / decksRemaining;
}

function roundToHalf(n) {
  return Math.round(n * 2) / 2;
}

// Builds 4 shuffled options (1 correct + 3 unique decoys) around a true value.
function buildOptions(actual, decoyStep, decimals) {
  const format = v => (decimals === 0 ? String(v) : (v > 0 ? '+' : '') + v.toFixed(decimals));
  const values = new Set([actual]);
  const offsets = [-3, -2, -1, 1, 2, 3].sort(() => Math.random() - 0.5);
  for (const mult of offsets) {
    if (values.size >= 4) break;
    const candidate = decimals === 0
      ? actual + mult * decoyStep
      : Math.round((actual + mult * decoyStep) * 10) / 10;
    values.add(candidate);
  }
  const options = Array.from(values).slice(0, 4).sort(() => Math.random() - 0.5);
  return options.map(v => ({ value: v, label: format(v) }));
}

function setupPanelButtons(containerId, dataAttr, assign) {
  const container = document.getElementById(containerId);
  container.querySelectorAll('.cc-option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.cc-option-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      assign(btn.dataset[dataAttr]);
    });
  });
}

setupPanelButtons('cc-deck-options', 'decks', v => { ccDeckCount = parseInt(v, 10); });
setupPanelButtons('cc-pace-options', 'pace', v => { ccPace = v; });

document.getElementById('cc-dismiss-instructions').addEventListener('click', () => {
  document.getElementById('cc-instructions-overlay').classList.add('hidden');
});
document.getElementById('cc-help-btn').addEventListener('click', () => {
  document.getElementById('cc-instructions-overlay').classList.remove('hidden');
});

document.getElementById('cc-start-btn').addEventListener('click', startRound);
document.getElementById('cc-stop-btn').addEventListener('click', stopDealingAndQuiz);
document.getElementById('cc-again-btn').addEventListener('click', startRound);
document.getElementById('cc-settings-btn').addEventListener('click', () => {
  show('cc-setup-panel');
});

function show(id) {
  ['cc-setup-panel', 'cc-table', 'cc-quiz-panel', 'cc-result-panel'].forEach(sec => {
    document.getElementById(sec).classList.toggle('hidden', sec !== id);
  });
}

function startRound() {
  clearInterval(ccDealTimer);
  ccShoe = makeShoe(ccDeckCount);
  ccDealt = [];
  ccRunningCount = 0;
  document.getElementById('cc-card-row').innerHTML = '';
  document.getElementById('cc-shoe-count').textContent = ccShoe.length;
  show('cc-table');

  const delay = PACE_DELAY_MS[ccPace] || PACE_DELAY_MS.medium;
  ccDealTimer = setInterval(() => {
    if (ccShoe.length <= 4) {
      stopDealingAndQuiz();
      return;
    }
    dealOneCardCC();
  }, delay);
}

function dealOneCardCC() {
  const card = ccShoe.pop();
  ccDealt.push(card);
  ccRunningCount += hiLoValue(card);
  document.getElementById('cc-shoe-count').textContent = ccShoe.length;

  const row = document.getElementById('cc-card-row');
  row.insertAdjacentHTML('beforeend', ccCardHTML(card));
  const wrap = document.getElementById('cc-card-row-wrap');
  wrap.scrollLeft = wrap.scrollWidth;
}

function stopDealingAndQuiz() {
  clearInterval(ccDealTimer);
  if (ccDealt.length === 0) return;
  askRunningCountQuestion();
}

let ccGuessRunning = null;
let ccGuessTrue = null;

function askRunningCountQuestion() {
  show('cc-quiz-panel');
  document.getElementById('cc-quiz-question').textContent = 'What is the running count?';
  document.getElementById('cc-quiz-subnote').textContent =
    `${ccDealt.length} cards were dealt from a ${ccDeckCount}-deck shoe. Pick the running count.`;

  const options = buildOptions(ccRunningCount, 1, 0);
  renderQuizOptions(options, (picked) => {
    ccGuessRunning = picked;
    askTrueCountQuestion();
  });
}

function askTrueCountQuestion() {
  document.getElementById('cc-quiz-question').textContent = 'And the true count?';
  document.getElementById('cc-quiz-subnote').textContent =
    'True count = running count ÷ decks remaining in the shoe.';

  const actualTrue = roundToHalf(ccTrueCount());
  const options = buildOptions(actualTrue, 0.5, 1);
  renderQuizOptions(options, (picked) => {
    ccGuessTrue = picked;
    showResult();
  });
}

function renderQuizOptions(options, onPick) {
  const wrap = document.getElementById('cc-quiz-options');
  wrap.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'cc-quiz-btn';
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('.cc-quiz-btn').forEach(b => b.disabled = true);
      onPick(opt.value);
    });
    wrap.appendChild(btn);
  });
}

function showResult() {
  const actualTrue = roundToHalf(ccTrueCount());
  const runningCorrect = ccGuessRunning === ccRunningCount;
  const trueCorrect = ccGuessTrue === actualTrue;

  ccSessionTotal += 2;
  ccSessionCorrect += (runningCorrect ? 1 : 0) + (trueCorrect ? 1 : 0);
  document.getElementById('cc-session-score').textContent = `${ccSessionCorrect}/${ccSessionTotal}`;
  document.getElementById('cc-session-pct').textContent =
    ccSessionTotal ? `${Math.round((ccSessionCorrect / ccSessionTotal) * 100)}%` : '–';

  const heading = (runningCorrect && trueCorrect) ? 'Both correct!'
    : (runningCorrect || trueCorrect) ? 'One out of two.'
    : 'Not quite — keep practicing.';
  document.getElementById('cc-result-heading').textContent = heading;

  setResultCell('cc-actual-running', ccRunningCount > 0 ? `+${ccRunningCount}` : String(ccRunningCount));
  setResultCell('cc-your-running', ccGuessRunning > 0 ? `+${ccGuessRunning}` : String(ccGuessRunning), runningCorrect);
  setResultCell('cc-actual-true', actualTrue > 0 ? `+${actualTrue.toFixed(1)}` : actualTrue.toFixed(1));
  setResultCell('cc-your-true', ccGuessTrue > 0 ? `+${ccGuessTrue.toFixed(1)}` : ccGuessTrue.toFixed(1), trueCorrect);

  show('cc-result-panel');
}

function setResultCell(id, text, correct) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.classList.remove('cc-correct', 'cc-wrong');
  if (correct === true) el.classList.add('cc-correct');
  if (correct === false) el.classList.add('cc-wrong');
}
