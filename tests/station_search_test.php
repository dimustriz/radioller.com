<?php
// Tests for searchStations() (station_search.php), the function backing the
// assistant.php 'search_stations' tool. Covers the exact scenarios requested
// for this change: a tag-based free-text query, empty matches, and search
// combined with the country / browser-playability filters.

declare(strict_types=1);

require_once __DIR__ . '/support/assert.php';
require_once __DIR__ . '/support/bootstrap.php';

/** @return array<string, callable(): void> */
function station_search_tests(): array {
    return [
        '"Найди разговорные станции" finds the matching talk station via its tag' => function (): void {
            $pdo = createStandardFixtureDatabase();

            $result = searchStations($pdo, 'Найди разговорные станции', '');

            checkEquals(1, $result['totalCount'], 'exactly one station should match');
            checkEquals(1, count($result['stations']), 'at most 8, exactly one here');
            checkEquals(3, $result['stations'][0]['id'], 'the matched station should be the Russian talk station');
            checkEquals(['Разговоры'], $result['matchedTags'], 'matchedTags should surface the matched tag');
        },

        'returns empty results and no matched tags for a query with no matches' => function (): void {
            $pdo = createStandardFixtureDatabase();

            $result = searchStations($pdo, 'xyz123xyz', '');

            checkEquals(0, $result['totalCount'], 'no stations should match');
            checkEquals([], $result['stations'], 'stations list should be empty');
            checkEquals([], $result['matchedTags'], 'matchedTags should be empty');
        },

        'country filter alone returns browser-playable stations for that country' => function (): void {
            $pdo = createStandardFixtureDatabase();

            $result = searchStations($pdo, '', 'US');

            // Station 4 (Music Wave) is US but ats=0 (not browser-playable) and must be excluded.
            checkEquals(2, $result['totalCount'], 'two playable US stations expected');
            $ids = array_column($result['stations'], 'id');
            sort($ids);
            checkEquals([1, 2], $ids, 'only the two playable US stations should be returned');
            checkEquals([], $result['matchedTags'], 'no text/tag query means no matched tags');
        },

        'query and country filters combine (tag match outside the requested country)' => function (): void {
            $pdo = createStandardFixtureDatabase();

            // "Talk" matches tag id 1, owned by a US station; filtering by RU
            // must still exclude it even though the tag itself matched.
            $result = searchStations($pdo, 'talk', 'RU');

            checkEquals(0, $result['totalCount'], 'no RU station matches the Talk tag or name');
            checkEquals([], $result['stations'], 'stations list should be empty');
            checkEquals(['Talk'], $result['matchedTags'], 'matchedTags reflects the tag match regardless of country filter');
        },

        'never returns a station explicitly flagged as not browser-playable' => function (): void {
            $pdo = createStandardFixtureDatabase();

            $result = searchStations($pdo, 'music', '');

            $ids = array_column($result['stations'], 'id');
            check(!in_array(4, $ids, true), 'station 4 (ats=0) must never be returned');
        },

        'an unknown ATS value is still treated as browser-playable' => function (): void {
            $pdo = createStandardFixtureDatabase();

            $result = searchStations($pdo, '', 'DE');

            checkEquals(1, $result['totalCount'], 'the DE station with unknown ats should be included');
            checkEquals(5, $result['stations'][0]['id'] ?? null, 'station with ats=null should be returned');
        },

        'response shape matches the assistant API contract' => function (): void {
            $pdo = createStandardFixtureDatabase();

            $result = searchStations($pdo, 'talk', '');

            checkEquals(['totalCount', 'stations', 'matchedTags'], array_keys($result), 'top-level keys must be stable');
            check(count($result['stations']) <= 8, 'at most 8 stations must be returned');
            $station = $result['stations'][0];
            checkEquals(
                ['id', 'name', 'country', 'state', 'language', 'category', 'bitrate', 'codec', 'votes', 'image', 'url'],
                array_keys($station),
                'per-station keys must match the shape expected by the MCP client',
            );
        },
    ];
}
