import { PagePlaceholder } from '../components/PagePlaceholder.jsx';

export function Leaderboard() {
  return (
    <PagePlaceholder title="Leaderboard" session={10}>
      Which models win when the drafts are judged blind. The win comes from stage 2's winner_labels,
      never from rounds.verdict_type.
    </PagePlaceholder>
  );
}
