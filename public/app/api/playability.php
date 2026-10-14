<?php

function isBrowserPlayableStation(array $station): bool {
    return ($station['ats'] ?? null) === null || (int)$station['ats'] === 1;
}

function browserPlayableSqlCondition(): string {
    return '(ats = 1 OR ats IS NULL)';
}
