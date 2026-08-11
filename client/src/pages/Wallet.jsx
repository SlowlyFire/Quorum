import { PagePlaceholder } from '../components/PagePlaceholder.jsx';

export function Wallet() {
  return (
    <PagePlaceholder title="Wallet" session={9}>
      Balance, Stripe top-ups in test mode, and the credit ledger. Nothing is debited yet — until
      Session 9 a temporary cap of 10 rounds per hour is the only thing rationing spend.
    </PagePlaceholder>
  );
}
