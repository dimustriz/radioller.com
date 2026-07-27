<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

require __DIR__ . '/db.php';

$q        = trim($_GET['q']        ?? '');
$country  = trim($_GET['country']  ?? '');
$category = trim($_GET['category'] ?? '');
$sort     = trim($_GET['sort']     ?? '');
$page     = max(1, (int)($_GET['page']     ?? 1));
$pageSize = min(100, max(1, (int)($_GET['pageSize'] ?? 50)));
$offset   = ($page - 1) * $pageSize;

$where  = ['1=1'];
$params = [];

if ($q !== '') {
    $where[]  = 'search_name LIKE ?';
    $params[] = '%' . $q . '%';
}
if ($country !== '') {
    $codes    = array_filter(array_map('trim', explode(',', $country)));
    if ($codes) {
        $where[]  = 'country_code IN (' . implode(',', array_fill(0, count($codes), '?')) . ')';
        $params   = array_merge($params, array_values($codes));
    }
}
if ($category !== '') {
    $codes    = array_filter(array_map('trim', explode(',', $category)));
    if ($codes) {
        $where[]  = 'category_code IN (' . implode(',', array_fill(0, count($codes), '?')) . ')';
        $params   = array_merge($params, array_values($codes));
    }
}

$orderBy = match($sort) {
    'name'    => 'ORDER BY name ASC',
    'votes'   => 'ORDER BY votes DESC',
    'bitrate' => 'ORDER BY bitrate DESC',
    default   => '',
};

$whereClause = implode(' AND ', $where);

// Total count
$countStmt = $pdo->prepare("SELECT COUNT(*) FROM stations WHERE $whereClause");
$countStmt->execute($params);
$totalCount = (int)$countStmt->fetchColumn();

// Paged results
$dataStmt = $pdo->prepare(
    "SELECT id, name, meta_name, search_name, source, source_original,
            image_source, url, country_code, state, bitrate, codec, lang,
            category_code, votes, hls, geo_lat, geo_long, ats, tags,
            region_code, is_default
     FROM stations
     WHERE $whereClause
     $orderBy
     LIMIT $pageSize OFFSET $offset"
);
$dataStmt->execute($params);
$rows = $dataStmt->fetchAll();

// Map snake_case columns to the camelCase JSON keys the Blazor app expects
$items = array_map(fn($r) => [
    'id'             => (int)$r['id'],
    'nm'             => $r['name'],
    'mn'             => $r['meta_name'],
    'sn'             => $r['search_name'],
    'sr'             => $r['source'],
    'so'             => $r['source_original'],
    'is'             => $r['image_source'],
    'ur'             => $r['url'],
    'cc'             => $r['country_code'],
    'st'             => $r['state'],
    'bt'             => (int)$r['bitrate'],
    'cd'             => $r['codec'],
    'lang'           => $r['lang'],
    'categoryCode'   => $r['category_code'],
    'vt'             => (int)$r['votes'],
    'hl'             => (int)$r['hls'],
    'gla'            => $r['geo_lat'] !== null ? (float)$r['geo_lat'] : null,
    'glo'            => $r['geo_long'] !== null ? (float)$r['geo_long'] : null,
    'ats'            => $r['ats'] !== null ? (int)$r['ats'] : null,
    'tg'             => $r['tags'] ? json_decode($r['tags']) : null,
    'rc'             => $r['region_code'],
    'df'             => (int)$r['is_default'],
], $rows);

echo json_encode([
    'items'      => $items,
    'totalCount' => $totalCount,
    'page'       => $page,
    'pageSize'   => $pageSize,
]);
