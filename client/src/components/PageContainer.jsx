import { Container } from '@mantine/core';

/**
 * THE ONE PAGE CONTAINER. Every full-page surface uses it and nothing sets its
 * own width.
 *
 * WHAT WENT WRONG WITHOUT IT. Each page reached for `<Container size="…">`
 * independently and they drifted: seven surfaces settled on `lg` (1140px), the
 * leaderboard on `xl` (1320px) and the shared view on `md` (960px). Every one of
 * them was individually centred — measured, they all had equal left and right
 * margins — so nothing looked broken on any single screen. The defect only
 * appeared when you MOVED between them: the content column jumped 180px wider on
 * the leaderboard and 180px narrower on a shared debate, which reads as the page
 * shifting under you rather than as a layout decision.
 *
 * A per-page width is not a decision anyone makes; it is a decision each page
 * makes again, slightly differently. So there is one width here and pages do not
 * take a `size`.
 *
 * `Container` already supplies `margin-inline: auto` and symmetric padding, so
 * this is deliberately thin — the value is that there is exactly one of it.
 */

/**
 * 1140px, which is Mantine's `lg` and what seven of the nine surfaces had
 * already converged on. Wide enough for the leaderboard's standings table (789px
 * at its widest) and the sessions table (720px), narrow enough that a paragraph
 * inside it is still a readable measure.
 */
export const PAGE_WIDTH = 1140;

/**
 * Vertical rhythm is a page's own business — a form wants less breathing room
 * than a dashboard — so `py` stays a prop. Horizontal padding does not: it is
 * what keeps content off the edge of a phone, and it is the other half of "these
 * pages line up".
 */
export function PageContainer({ children, py = { base: 'lg', sm: 'xl' }, ...props }) {
  return (
    <Container size={PAGE_WIDTH} py={py} {...props}>
      {children}
    </Container>
  );
}
