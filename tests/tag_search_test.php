<?php
// Tests for radiollerTagSearch() (tag_search.php), covering the move from
// Tag.zip/StationTag.zip parsing to indexed MySQL lookups against the 'tags'
// and 'station_tags' tables. No ZipArchive usage anywhere in this flow.

declare(strict_types=1);

require_once __DIR__ . '/support/assert.php';
require_once __DIR__ . '/support/bootstrap.php';

/** @return array<string, callable(): void> */
function tag_search_tests(): array {
    return [
        'matches an exact English tag name' => function (): void {
            $pdo = createStandardFixtureDatabase();

            $result = radiollerTagSearch('Talk', $pdo);

            checkEquals([1], $result['stationIds'], 'stationIds should contain only the station tagged Talk');
            checkEquals(['Talk'], $result['matchedTags'], 'matchedTags should contain the matched tag name');
        },

        'matches a Russian query via stemming against a Russian tag' => function (): void {
            $pdo = createStandardFixtureDatabase();

            // "Найди разговорные станции" = "Find talk stations" — 'найди' and
            // 'станции' are stop words; 'разговорные' must fuzzy-match the tag
            // 'Разговоры' through normalizeTagWord()/tagWordsMatch() stemming.
            $result = radiollerTagSearch('Найди разговорные станции', $pdo);

            checkEquals([3], $result['stationIds'], 'stationIds should contain only the Russian talk station');
            checkEquals(['Разговоры'], $result['matchedTags'], 'matchedTags should contain the matched Russian tag');
        },

        'returns empty matches for a query with no corresponding tag' => function (): void {
            $pdo = createStandardFixtureDatabase();

            $result = radiollerTagSearch('xyz123xyz', $pdo);

            checkEquals([], $result['stationIds'], 'no station ids expected');
            checkEquals([], $result['matchedTags'], 'no matched tags expected');
        },

        'returns empty matches when the query only contains stop words' => function (): void {
            $pdo = createStandardFixtureDatabase();

            $result = radiollerTagSearch('Найди станции пожалуйста', $pdo);

            checkEquals([], $result['stationIds'], 'stop-word-only query should not reach the database');
            checkEquals([], $result['matchedTags'], 'stop-word-only query should not reach the database');
        },

        'does not require ZipArchive to be available' => function (): void {
            check(
                !str_contains(file_get_contents(__DIR__ . '/../public/app/api/tag_search.php') ?: '', 'ZipArchive'),
                'tag_search.php must no longer reference ZipArchive/Tag.zip/StationTag.zip',
            );
        },
    ];
}
