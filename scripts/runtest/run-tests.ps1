#!/usr/bin/env pwsh

Write-Host "Starting test suite execution..." -ForegroundColor Green
Write-Host "=================================" -ForegroundColor Green

$tests = @(
    "tests/btcrelay.test.ts",
    "tests/telebtc.test.ts", 
    "tests/transfer.test.ts",
    "tests/burn.test.ts",
    "tests/locker.test.ts"
)

$totalTests = $tests.Count
$currentTest = 1

foreach ($test in $tests) {
    Write-Host ""
    Write-Host "[$currentTest/$totalTests] Running: $test" -ForegroundColor Yellow
    Write-Host "----------------------------------------" -ForegroundColor Yellow
    
    try {
        npm test -- --run $test
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ $test - PASSED" -ForegroundColor Green
        } else {
            Write-Host "❌ $test - FAILED (Exit code: $LASTEXITCODE)" -ForegroundColor Red
        }
    } catch {
        Write-Host "❌ $test - ERROR: $($_.Exception.Message)" -ForegroundColor Red
    }
    
    $currentTest++
    
    if ($currentTest -le $totalTests) {
        Write-Host "Waiting 2 seconds before next test..." -ForegroundColor Cyan
        Start-Sleep -Seconds 2
    }
}

Write-Host ""
Write-Host "=================================" -ForegroundColor Green
Write-Host "Test suite execution completed!" -ForegroundColor Green
