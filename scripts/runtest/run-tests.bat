@echo off
echo Starting test suite execution...
echo =================================

set tests=btcrelay.test.ts telebtc.test.ts transfer.test.ts burn.test.ts locker.test.ts
set count=0

for %%t in (%tests%) do (
    set /a count+=1
    echo.
    echo [%count%/5] Running: tests/%%t
    echo ----------------------------------------
    
    npm test -- --run tests/%%t
    
    if %errorlevel% equ 0 (
        echo ✅ tests/%%t - PASSED
    ) else (
        echo ❌ tests/%%t - FAILED ^(Exit code: %errorlevel%^)
    )
    
    if %count% lss 5 (
        echo Waiting 2 seconds before next test...
        timeout /t 2 /nobreak >nul
    )
)

echo.
echo =================================
echo Test suite execution completed!
pause
