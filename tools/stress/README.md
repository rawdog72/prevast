# Stress harness

Python: install `websockets` into your Python environment. From the project root:

```powershell
npm run server:benchmark
```

In another terminal:

```powershell
Set-Location runtime/benchmark
python ../../tools/stress/run.py --port 8272 --bots 50 --duration 30
```

The scope benchmark compares tick cost with nobody aiming, half the bots aiming the tube scope, and half aiming the sniper, all in one server session. With `npm run server:benchmark` running, from `runtime/benchmark`:

```powershell
python ../../tools/stress/aimbench.py --password <config.lua adminPassword>
```

Use `shard.py` for multiple bot processes; use `npm run smoke` for integration checks. Shard outputs default to the current directory. The C++ bot project is in cpp/ and writes to dist/stress/<Configuration>; build it with the same MSBuild/vcpkg environment as the game server.
