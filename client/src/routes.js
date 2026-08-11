/**
 * Route constants that more than one module needs.
 *
 * Lives outside App.jsx so that Login can import the post-sign-in destination
 * without importing the component tree that renders Login — a cycle that works
 * until the day it does not.
 */

/** Where a signed-in user lands when nothing else asked for them. */
export const DEFAULT_SIGNED_IN_ROUTE = '/new';

/** Where a signed-in visitor to /login or /register is sent instead. */
export const SIGNED_IN_HOME = '/sessions';
