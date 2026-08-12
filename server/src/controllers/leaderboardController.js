import { getLeaderboard } from '../services/leaderboardService.js';

export async function getStandings(req, res, next) {
  try {
    const { scope, days } = req.query;

    res.json({
      leaderboard: await getLeaderboard({ userId: req.user.id, scope, days }),
    });
  } catch (error) {
    next(error);
  }
}
