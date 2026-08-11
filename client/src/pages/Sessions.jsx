import { PagePlaceholder } from '../components/PagePlaceholder.jsx';

export function Sessions() {
  return (
    <PagePlaceholder title="Sessions" session={8}>
      Every debate you have run, newest first. GET /api/sessions already returns them with their
      round counts and pagination.
    </PagePlaceholder>
  );
}
