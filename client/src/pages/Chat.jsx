import { useParams } from 'react-router-dom';

import { PagePlaceholder } from '../components/PagePlaceholder.jsx';

export function Chat() {
  const { sessionId } = useParams();

  return (
    <PagePlaceholder title="Debate" session={8}>
      The four-stage transcript for session {sessionId}, streamed live over an EventSource on
      /api/rounds/:id/stream. This is mockup 02 and the main screen of the product.
    </PagePlaceholder>
  );
}
