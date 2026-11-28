UPDATE worker_enrollment_challenges
SET superseded_at = NULL
WHERE challenge_id = 'challenge-d1-expired';
