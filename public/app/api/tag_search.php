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

function radiollerTagSearch(string $query, ?string $dataDirectory = null): array {
    if (!function_exists('mb_strtolower') || !class_exists(ZipArchive::class)) {
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

    $dataDirectory ??= dirname(__DIR__, 2) . '/data';
    $tagArchive = new ZipArchive();
    $tagPath = $dataDirectory . '/Tag.zip';
    if ($tagArchive->open($tagPath) !== true) {
        throw new RuntimeException('Radioller tag catalog is unavailable');
    }
    $tagJson = $tagArchive->getFromName('Tag.json');
    $tagArchive->close();
    if ($tagJson === false) throw new RuntimeException('Radioller tag catalog is invalid');

    try {
        $tagData = json_decode($tagJson, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $error) {
        throw new RuntimeException('Radioller tag catalog is invalid', 0, $error);
    }
    if (!is_array($tagData['id'] ?? null) || !is_array($tagData['nm'] ?? null)
        || count($tagData['id']) !== count($tagData['nm'])) {
        throw new RuntimeException('Radioller tag catalog is invalid');
    }

    $matchedTags = [];
    $matchedTagIds = [];
    foreach ($tagData['id'] as $index => $id) {
        $name = $tagData['nm'][$index] ?? null;
        if (!is_int($id) || !is_string($name)) continue;

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

    $associationArchive = new ZipArchive();
    $associationPath = $dataDirectory . '/StationTag.zip';
    if ($associationArchive->open($associationPath) !== true) {
        throw new RuntimeException('Radioller station-tag index is unavailable');
    }
    $associationJson = $associationArchive->getFromName('StationTag.json');
    $associationArchive->close();
    if ($associationJson === false) throw new RuntimeException('Radioller station-tag index is invalid');

    try {
        $associationData = json_decode($associationJson, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $error) {
        throw new RuntimeException('Radioller station-tag index is invalid', 0, $error);
    }
    if (!is_array($associationData['si'] ?? null) || !is_array($associationData['ti'] ?? null)
        || count($associationData['si']) !== count($associationData['ti'])) {
        throw new RuntimeException('Radioller station-tag index is invalid');
    }

    $stationIds = [];
    foreach ($associationData['si'] as $index => $stationId) {
        $tagIds = $associationData['ti'][$index] ?? null;
        if (!is_int($stationId) || !is_array($tagIds)) continue;
        foreach ($tagIds as $tagId) {
            if (isset($matchedTagIds[$tagId])) {
                $stationIds[$stationId] = true;
                break;
            }
        }
    }

    return [
        'stationIds' => array_map('intval', array_keys($stationIds)),
        'matchedTags' => array_values($matchedTags),
    ];
}
