// Shared card/deck utilities used by both the play page (game.js) and the
// simulation page (simulate.js). Keeping this in one place guarantees both
// pages deal and score hands identically.

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function rankValue(rank) {
  if (rank === 'A') return 11;
  if (['J', 'Q', 'K'].includes(rank)) return 10;
  return parseInt(rank, 10);
}

function cardPairRank(card) {
  if (card.rank === 'A') return 11;
  if (['J', 'Q', 'K'].includes(card.rank)) return 10;
  return parseInt(card.rank, 10);
}

// Hi-Lo card counting value: 2-6 = +1, 7-9 = 0, 10/face/A = -1.
function hiLoValue(card) {
  if (['2', '3', '4', '5', '6'].includes(card.rank)) return 1;
  if (['7', '8', '9'].includes(card.rank)) return 0;
  return -1;
}

function evaluateHand(cards) {
  let total = cards.reduce((sum, c) => sum + rankValue(c.rank), 0);
  let aces = cards.filter(c => c.rank === 'A').length;
  let soft = aces > 0;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  // "soft" only if an ace is still counted as 11
  const isSoft = soft && aces > 0 && total <= 21;
  return { total, isSoft, isBust: total > 21, isBlackjack: cards.length === 2 && total === 21 };
}

function makeOrderedDeck(numDecks) {
  const deck = [];
  for (let d = 0; d < numDecks; d++) {
    for (const s of SUITS) {
      for (const r of RANKS) {
        deck.push({ rank: r, suit: s });
      }
    }
  }
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function makeShoe(numDecks) {
  return shuffle(makeOrderedDeck(numDecks));
}
