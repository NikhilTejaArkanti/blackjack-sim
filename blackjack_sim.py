import random

RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]
SUITS = ["♠", "♥", "♦", "♣"]


def new_shoe(num_decks=1):
    shoe = [(rank, suit) for rank in RANKS for suit in SUITS] * num_decks
    random.shuffle(shoe)
    return shoe


def card_value(rank):
    if rank in ("J", "Q", "K"):
        return 10
    if rank == "A":
        return 11
    return int(rank)


def hand_value(hand):
    total = sum(card_value(rank) for rank, _ in hand)
    aces = sum(1 for rank, _ in hand if rank == "A")
    while total > 21 and aces:
        total -= 10
        aces -= 1
    return total


def is_blackjack(hand):
    return len(hand) == 2 and hand_value(hand) == 21


def deal(shoe):
    return [shoe.pop(), shoe.pop()]


def play_dealer(shoe, hand):
    while hand_value(hand) < 17:
        hand.append(shoe.pop())
    return hand


def basic_strategy_hit(hand, dealer_up):
    total = hand_value(hand)
    return total < 17


def play_round(shoe):
    player = deal(shoe)
    dealer = deal(shoe)

    if is_blackjack(player):
        if is_blackjack(dealer):
            return 0
        return 1.5

    while basic_strategy_hit(player, dealer[0]):
        player.append(shoe.pop())
        if hand_value(player) > 21:
            return -1

    dealer = play_dealer(shoe, dealer)
    dealer_total = hand_value(dealer)
    player_total = hand_value(player)

    if dealer_total > 21:
        return 1
    if player_total > dealer_total:
        return 1
    if player_total < dealer_total:
        return -1
    return 0


def simulate(num_rounds=10000, num_decks=6):
    shoe = new_shoe(num_decks)
    bankroll = 0.0
    results = {"win": 0, "lose": 0, "push": 0}

    for _ in range(num_rounds):
        if len(shoe) < 15:
            shoe = new_shoe(num_decks)

        outcome = play_round(shoe)
        bankroll += outcome

        if outcome > 0:
            results["win"] += 1
        elif outcome < 0:
            results["lose"] += 1
        else:
            results["push"] += 1

    return bankroll, results


if __name__ == "__main__":
    rounds = 10000
    net, results = simulate(rounds)
    print(f"Rounds played: {rounds}")
    print(f"Wins: {results['win']}  Losses: {results['lose']}  Pushes: {results['push']}")
    print(f"Net units: {net:.2f}")
    print(f"Units per round: {net / rounds:.4f}")
