<?php

// This stream was manually verified over HTTPS: it returns audio/mpeg and
// playable MP3 data, although the legacy iOS ATS field has no value for it.
const VERIFIED_BROWSER_STREAM_IDS = [1955083349];

function isBrowserPlayableStation(array $station): bool {
    return (int)($station['ats'] ?? 0) === 1
        || in_array((int)($station['id'] ?? 0), VERIFIED_BROWSER_STREAM_IDS, true);
}

function browserPlayableSqlCondition(): string {
    $verifiedIds = implode(',', VERIFIED_BROWSER_STREAM_IDS);
    return '(ats = 1 OR id IN (' . $verifiedIds . '))';
}
