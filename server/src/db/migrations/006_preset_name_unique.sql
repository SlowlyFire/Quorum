-- Migration 006 — a preset's name is unique per user, Session 10.
--
-- `presets` has existed since migration 001 with nothing written to it and no
-- constraint on `name`. Session 10 is the first to write, and §4.7 has the user
-- "create, rename, duplicate, delete" — a list in which two presets called
-- "Code review" is a list nobody can use, and Duplicate is the operation most
-- likely to produce one.
--
-- CASE-INSENSITIVE, on lower(name). "Code review" and "code review" are the same
-- name to the person reading the list, and a uniqueness rule that disagrees with
-- the user about what "the same" means is a rule that surprises them. The
-- service trims before insert, so trailing whitespace cannot smuggle a duplicate
-- past this either.
--
-- Scoped to the user. Two people may both have a "Full council" — in fact both
-- get one at registration.
--
-- presetService catches 23505 on this index and answers 409 with the name in the
-- message, so the constraint is the check rather than a SELECT that would lose
-- the race between two simultaneous creates.

CREATE UNIQUE INDEX idx_presets_user_id_name
  ON presets (user_id, lower(name));

-- The list endpoint reads every preset for one user, ordered by creation.
CREATE INDEX idx_presets_user_id_created_at
  ON presets (user_id, created_at);
