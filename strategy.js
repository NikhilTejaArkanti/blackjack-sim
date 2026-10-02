// Basic strategy chart (Casino Rides of Dallas), encoded from the provided image.
// Columns always correspond to dealer upcard: 2,3,4,5,6,7,8,9,10,A
// Codes: H=Hit, S=Stand, D=Double, P=Split, R=Surrender. "X/Y" = X if available, else Y.

const DEALER_COLS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A'];

function colIndex(dealerRank) {
  const r = dealerRank === 'J' || dealerRank === 'Q' || dealerRank === 'K' ? '10' : dealerRank;
  return DEALER_COLS.indexOf(r);
}

// Hard totals 8-17 (totals <8 always Hit, totals >17 always Stand)
const HARD = {
  8:  ['H','H','H','H','H','H','H','H','H','H'],
  9:  ['H','D/H','D/H','D/H','D/H','H','H','H','H','H'],
  10: ['D/H','D/H','D/H','D/H','D/H','D/H','D/H','D/H','H','H'],
  11: ['D/H','D/H','D/H','D/H','D/H','D/H','D/H','D/H','D/H','D/H'],
  12: ['H','H','S','S','S','H','H','H','H','H'],
  13: ['S','S','S','S','S','H','H','H','H','H'],
  14: ['S','S','S','S','S','H','H','H','H','H'],
  15: ['S','S','S','S','S','H','H','H','R/H','H'],
  16: ['S','S','S','S','S','H','H','R/H','R/H','R/H'],
  17: ['S','S','S','S','S','S','S','S','S','S'],
};

// Soft totals A,2 - A,8 (soft 19/A9 and soft 20... not on chart -> always Stand; soft 21 is blackjack)
const SOFT = {
  2: ['H','H','H','D/H','D/H','H','H','H','H','H'], // A,2
  3: ['H','H','H','D/H','D/H','H','H','H','H','H'], // A,3
  4: ['H','H','D/H','D/H','D/H','H','H','H','H','H'], // A,4
  5: ['H','H','D/H','D/H','D/H','H','H','H','H','H'], // A,5
  6: ['H','D/H','D/H','D/H','D/H','H','H','H','H','H'], // A,6
  7: ['S','D/S','D/S','D/S','D/S','S','S','H','H','H'], // A,7
  8: ['S','S','S','S','S','S','S','S','S','S'], // A,8
};

// Pairs 2,2 - 10,10 and A,A
const PAIRS = {
  2:  ['P/H','P/H','P','P','P','P','H','H','H','H'],
  3:  ['P/H','P/H','P','P','P','P','H','H','H','H'],
  4:  ['H','H','H','P/H','P/H','H','H','H','H','H'],
  5:  ['D/H','D/H','D/H','D/H','D/H','D/H','D/H','D/H','H','H'],
  6:  ['P/H','P','P','P','P','H','H','H','H','H'],
  7:  ['P','P','P','P','P','P','H','H','H','H'],
  8:  ['P','P','P','P','P','P','P','P','P','P'],
  9:  ['P','P','P','P','P','S','P','P','S','S'],
  10: ['S','S','S','S','S','S','S','S','S','S'],
  11: ['P','P','P','P','P','P','P','P','P','P'], // A,A (keyed as 11)
};

const ACTION_NAMES = {
  H: 'Hit',
  S: 'Stand',
  D: 'Double',
  P: 'Split',
  R: 'Surrender',
};

/**
 * Resolve a chart token like "D/H" into an actual recommendation given
 * which actions are currently legal.
 */
function resolveToken(token, legal) {
  const [primary, fallback] = token.split('/');
  const pick = legal[primary] ? primary : (fallback || primary);
  const finalPick = legal[pick] ? pick : 'H';
  return finalPick;
}

/**
 * hand: { isPair, pairRank (2-10, 11=Ace), isSoft, softAceTotal (2-8), hardTotal }
 * legal: { H, S, D, P, R } booleans for what's actually allowed right now
 */
function getRecommendation(hand, dealerRank, legal) {
  const col = colIndex(dealerRank);
  let token;

  if (hand.isPair && legal.P) {
    const row = PAIRS[hand.pairRank];
    token = row ? row[col] : null;
  }

  if (!token) {
    if (hand.isSoft && hand.softAceTotal >= 2 && hand.softAceTotal <= 8) {
      token = SOFT[hand.softAceTotal][col];
    } else if (hand.isSoft) {
      // soft 19 (A,9) and above: always stand
      token = 'S';
    } else {
      const t = hand.hardTotal;
      if (t < 8) token = 'H';
      else if (t > 17) token = 'S';
      else token = HARD[t][col];
    }
  }

  const action = resolveToken(token, legal);
  return { action, actionName: ACTION_NAMES[action], token };
}
