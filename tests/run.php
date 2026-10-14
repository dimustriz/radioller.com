<?php
// Dependency-free test runner for the assistant API's PHP tests.
// Usage: php tests/run.php

declare(strict_types=1);

require_once __DIR__ . '/support/assert.php';

$testFiles = glob(__DIR__ . '/*_test.php') ?: [];
sort($testFiles);

$totalPassed = 0;
$totalFailed = 0;

foreach ($testFiles as $testFile) {
    require $testFile;

    $suiteName = basename($testFile, '.php');
    $factoryName = $suiteName . 's';
    if (!function_exists($factoryName)) {
        // Fallback: derive the factory name from the file (foo_test.php -> foo_tests()).
        $factoryName = preg_replace('/_test$/', '_tests', $suiteName) ?? $suiteName;
    }
    if (!function_exists($factoryName)) {
        fwrite(STDERR, "No test factory function found for $testFile (expected $factoryName())\n");
        $totalFailed++;
        continue;
    }

    echo "== $suiteName ==\n";
    foreach ($factoryName() as $name => $testCase) {
        try {
            $testCase();
            echo "  PASS  $name\n";
            $totalPassed++;
        } catch (Throwable $error) {
            echo "  FAIL  $name\n";
            echo '        ' . str_replace("\n", "\n        ", $error->getMessage()) . "\n";
            $totalFailed++;
        }
    }
}

echo "\n$totalPassed passed, $totalFailed failed\n";
exit($totalFailed === 0 ? 0 : 1);
