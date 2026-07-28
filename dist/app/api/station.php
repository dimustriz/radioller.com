<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

require __DIR__ . '/db.php';

$id = (int)($_GET['id'] ?? 0);
if ($id <= 0) {
    http_response_code(400);
    die(json_encode(['error' => 'Missing id']));
}

$stmt = $pdo->prepare('SELECT * FROM stations WHERE id = ? LIMIT 1');
$stmt->execute([$id]);
$r = $stmt->fetch();

if (!$r) {
    http_response_code(404);
    die(json_encode(['error' => 'Not found']));
}

echo json_encode([
    'id'           => (int)$r['id'],
    'nm'           => $r['name'],
    'mn'           => $r['meta_name'],
    'sn'           => $r['search_name'],
    'sr'           => $r['source'],
    'so'           => $r['source_original'],
    'is'           => $r['image_source'],
    'ur'           => $r['url'],
    'cc'           => $r['country_code'],
    'st'           => $r['state'],
    'bt'           => (int)$r['bitrate'],
    'cd'           => $r['codec'],
    'lang'         => $r['lang'],
    'categoryCode' => $r['category_code'],
    'vt'           => (int)$r['votes'],
    'hl'           => (int)$r['hls'],
    'gla'          => $r['geo_lat'] !== null ? (float)$r['geo_lat'] : null,
    'glo'          => $r['geo_long'] !== null ? (float)$r['geo_long'] : null,
    'ats'          => $r['ats'] !== null ? (int)$r['ats'] : null,
    'tg'           => $r['tags'] ? json_decode($r['tags']) : null,
    'rc'           => $r['region_code'],
    'df'           => (int)$r['is_default'],
]);
