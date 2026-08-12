/**
 * May this user start this round, and who pays for it.
 *
 * §8 words POST /sessions/:id/rounds as "pre-flight cost check, then run stages
 * 1-4". This is that check, and it is §3's rule with nothing added:
 *
 *   estimate  = estimateRoundCost(plan)
 *   threshold = max($0.05, estimate x 1.5)
 *
 *   balance >= threshold  ->  allowed, mode 'paid'   (the round is debited)
 *   otherwise             ->  rounds started today in UTC
 *                             < 2  ->  allowed, mode 'free'  (nothing debited)
 *                             else ->  denied, 402
 *
 * WHY THE THRESHOLD IS RELATIVE. §3: a four-model council costs many times what
 * a two-model one does, so a flat floor is either too strict for the small
 * council or too loose for the large one. The 1.5x is headroom for the fact
 * that the estimate is an estimate — OpenRouter bills whichever upstream it
 * routed to (decision 16) — and the $0.05 floor stops a very cheap council
 * being allowed to start on a balance too small to settle anything.
 *
 * WHY A FREE ROUND WRITES NO LEDGER ROW AT ALL. The first design wrote a
 * `bonus` row of amount 0 so the ledger would explain where the round went. It
 * is worse: a row of zero moves no balance, so `balance_after` restates the
 * previous row and the ledger's own invariant — SUM(amount) = balance — is
 * carried by rows that say nothing. The round is already its own record, and
 * `rounds.total_cost` still holds exactly what it cost us, so nothing is lost;
 * what is gained is that every row in credit_transactions is a row where money
 * moved, which is the only property that makes a financial ledger readable
 * (decision 34).
 *
 * NO RESERVATIONS. The balance is checked before the round and debited after
 * it, and nothing is held in between. Two rounds started at once can therefore
 * both pass a check that only one of them could afford, and the balance ends
 * marginally negative — which §3 allows explicitly and which the next round's
 * check catches. A reserve-and-refund system for fractions of a cent would be
 * more machinery than the money it protects.
 */
import { FREE_ROUNDS_PER_DAY, MINIMUM_THRESHOLD, THRESHOLD_MULTIPLE } from '../config/billing.js';
import { countRoundsForUserToday } from '../models/roundModel.js';
import { estimateCallCount, estimateRoundCost } from './costEstimateService.js';
import { getBalance } from './walletService.js';

export function thresholdFor(estimate) {
  return Math.max(MINIMUM_THRESHOLD, Number(estimate ?? 0) * THRESHOLD_MULTIPLE);
}

/**
 * Takes a planCouncil result — the same object the engine runs — so the round
 * that is quoted and the round that is run are the same line-up by
 * construction, not by both being built from the same request twice.
 *
 * Always returns; never throws for a refusal. The caller turns `allowed: false`
 * into the 402, because deciding is this service's job and answering is the
 * HTTP layer's.
 */
/**
 * `promptText` is the question, and it is here because Session 13 found the
 * quote scaling with it: a 141-character judgement call costs about 2.5x what a
 * 45-character factual one does, and the estimator used to price them the same.
 * Since §3's threshold is `max($0.05, estimate x 1.5)`, that under-quote decided
 * who paid. Optional, and an absent question quotes exactly as it did before.
 */
export async function canStartRound(userId, plan, promptText = '') {
  const estimate = estimateRoundCost(plan, promptText);
  const threshold = thresholdFor(estimate);
  const balance = await getBalance(userId);

  if (balance >= threshold) {
    return {
      allowed: true,
      mode: 'paid',
      reason: null,
      estimate,
      threshold,
      balance,
      callCount: estimateCallCount(plan),
      /** Not counted: a paid round does not touch the allowance, and asking
       *  would be a query the answer does not depend on. */
      freeRemaining: null,
    };
  }

  const usedToday = await countRoundsForUserToday(userId);
  const freeRemaining = Math.max(0, FREE_ROUNDS_PER_DAY - usedToday);

  const shared = {
    mode: 'free',
    estimate,
    threshold,
    balance,
    callCount: estimateCallCount(plan),
    freeRemaining,
  };

  if (freeRemaining > 0) {
    return { ...shared, allowed: true, reason: null };
  }

  return {
    ...shared,
    allowed: false,
    /**
     * Two codes for one rule, because the two situations have different
     * remedies and the client says something different for each. A user with
     * money in the wallet that will not cover this council can fix it by
     * shrinking the council or by topping up a little; a user with an empty
     * wallet has used the allowance and can only top up or wait for UTC
     * midnight. Both are 402 and both carry the same figures.
     */
    reason: balance > 0 ? 'INSUFFICIENT_CREDIT' : 'DAILY_LIMIT_REACHED',
  };
}

/**
 * The refusal as a sentence. Kept beside the rule rather than in the
 * controller, so the wording cannot drift from the branch that produced it.
 */
export function denialMessage(decision) {
  if (decision.reason === 'INSUFFICIENT_CREDIT') {
    return (
      `This round is estimated at $${decision.estimate.toFixed(4)}, which needs a balance of at least ` +
      `$${decision.threshold.toFixed(2)}; yours is $${decision.balance.toFixed(4)}. ` +
      `You have also used today's ${FREE_ROUNDS_PER_DAY} free debates. Top up, or use a smaller council.`
    );
  }

  return (
    `You have used today's ${FREE_ROUNDS_PER_DAY} free debates. ` +
    'Top up your wallet to keep going, or come back after 00:00 UTC.'
  );
}
