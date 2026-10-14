<?php

function normalizeTagWord(string $word): string {
    $word = mb_strtolower($word, 'UTF-8');
    $word = preg_replace('/[^\p{L}\p{N}]+/u', '', $word) ?? '';

    foreach ([
        'иями', 'ями', 'ами', 'ого', 'ему', 'ыми', 'ими', 'ее', 'ие', 'ые',
        'ое', 'ая', 'яя', 'ый', 'ий', 'ой', 'ей', 'ых', 'их', 'ую', 'юю',
        'ам', 'ям', 'ом', 'ем', 'ов', 'ев', 'ах', 'ях', 'ы', 'и', 'а', 'я',
        'о', 'е',
    ] as $suffix) {
        if (mb_strlen($word, 'UTF-8') - mb_strlen($suffix, 'UTF-8') >= 4
            && str_ends_with($word, $suffix)) {
            return mb_substr($word, 0, -mb_strlen($suffix, 'UTF-8'), 'UTF-8');
        }
    }

    return $word;
}

function tagWordsMatch(string $left, string $right): bool {
    $left = normalizeTagWord($left);
    $right = normalizeTagWord($right);
    if ($left === '' || $right === '') return false;
    if ($left === $right) return true;

    $shorterLength = min(mb_strlen($left, 'UTF-8'), mb_strlen($right, 'UTF-8'));
    if ($shorterLength < 5 || abs(mb_strlen($left, 'UTF-8') - mb_strlen($right, 'UTF-8')) > 3) {
        return false;
    }

    return str_starts_with($left, $right) || str_starts_with($right, $left);
}

/**
 * Finds stations whose tags match words in a free-text query.
 *
 * Reads the tag dictionary and station-tag relations from MySQL (tables
 * 'tags' and 'station_tags', populated by the importer's tag-catalog.sql)
 * instead of opening Tag.zip/StationTag.zip on every request. The 'tags'
 * table is small, so it is loaded in full and matched in PHP (stemming and
 * fuzzy prefix matching are not practical to express in SQL); the much
 * larger station-tag lookup is then a single indexed query on tag_id.
 */
function radiollerTagSearch(string $query, ?PDO $pdo = null): array {
    $pdo ??= $GLOBALS['pdo'] ?? null;
    if (!function_exists('mb_strtolower') || !$pdo instanceof PDO) {
        throw new RuntimeException('Radioller tag-search requirements are unavailable');
    }

    $stopWords = [
        'найди', 'найти', 'подбери', 'покажи', 'станции', 'станция', 'станций',
        'радио', 'радиостанции', 'радиостанция', 'радиостанций', 'пожалуйста',
        'хочу', 'включи', 'мне', 'find', 'show', 'recommend', 'station', 'stations',
        'radio', 'please', 'some',
    ];
    $queryWords = preg_split('/[^\p{L}\p{N}]+/u', mb_strtolower($query, 'UTF-8'), -1, PREG_SPLIT_NO_EMPTY) ?: [];
    $queryWords = array_values(array_filter(
        $queryWords,
        static fn(string $word): bool => mb_strlen($word, 'UTF-8') >= 3 && !in_array($word, $stopWords, true),
    ));
    if (!$queryWords) return ['stationIds' => [], 'matchedTags' => []];

    try {
        $tagRows = $pdo->query('SELECT id, name FROM tags')->fetchAll();
    } catch (PDOException $error) {
        throw new RuntimeException('Radioller tag catalog is unavailable', 0, $error);
    }

    $matchedTags = [];
    $matchedTagIds = [];
    foreach ($tagRows as $tagRow) {
        $id = (int)$tagRow['id'];
        $name = $tagRow['name'] ?? null;
        if ($name === null || $name === '') continue;

        $tagTokens = preg_split('/[^\p{L}\p{N}]+/u', mb_strtolower($name, 'UTF-8'), -1, PREG_SPLIT_NO_EMPTY) ?: [];
        foreach ($queryWords as $queryWord) {
            foreach ($tagTokens as $tagToken) {
                if (tagWordsMatch($queryWord, $tagToken)) {
                    $matchedTagIds[$id] = true;
                    $matchedTags[$id] = $name;
                    continue 3;
                }
            }
        }
    }

    if (!$matchedTagIds) return ['stationIds' => [], 'matchedTags' => []];

    $tagIds = array_keys($matchedTagIds);
    try {
        $placeholders = implode(',', array_fill(0, count($tagIds), '?'));
        $stmt = $pdo->prepare("SELECT DISTINCT station_id FROM station_tags WHERE tag_id IN ($placeholders)");
        $stmt->execute($tagIds);
        $stationIds = array_map('intval', array_column($stmt->fetchAll(), 'station_id'));
    } catch (PDOException $error) {
        throw new RuntimeException('Radioller station-tag index is unavailable', 0, $error);
    }

    return [
        'stationIds' => $stationIds,
        'matchedTags' => array_values($matchedTags),
    ];
}
