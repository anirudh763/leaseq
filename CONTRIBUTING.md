# Contributing

Thanks for helping. leaseq is a small reference implementation of a
lease-and-fence job queue, so the most useful contributions are careful ones.

## Ways to help

- **Try to break the guarantee.** If you can make a job get lost, or get a
  result recorded twice, with the fenced workers, open a "Queue guarantee"
  issue with the command and seed. That is the one claim this project makes.
- **Run the fault-injection test elsewhere.** `python scripts/chaos.py --seed N`
  on another machine or PostgreSQL version, and share the JSON it prints.
- **Report a problem** in the API, the dashboard or the Docker setup.

## Setting up

You need Python 3.13 and PostgreSQL 16 (the only versions tested).

```bash
pip install -r requirements.txt
scripts/dev_postgres.sh start           # throwaway PostgreSQL on port 54329
export LEASEQ_DATABASE_URL=postgresql://leaseq@127.0.0.1:54329/leaseq
python -m pytest -q
```

The browser tests in `tests/test_dashboard_e2e.py` need Node, the `playwright`
package and axe-core (`AXE_PATH=/path/to/axe.min.js`); without them they are
skipped. With Docker, `scripts/up.sh` starts the whole stack.

## Before you open a pull request

- Run `python -m pytest -q` and, if you changed a protection, `python tools/sabotage.py -k <name>`.
  A new protection gets a test that fails without it, and an entry in `tools/sabotage.py`.
- Changing `queue.py` or `schema.sql` changes the claim being tested. Run
  `python scripts/chaos.py --seed 1` and the negative control
  (`--jobs 60 --kills 0 --stall-fraction 0.25 --unfenced`, which must FAIL),
  and paste both results into the pull request.
- Keep the dashboard free of a build step, CDN and third-party code, and keep
  axe-core at 0 violations in light and dark.
- Bump `leaseq.__version__` and add a CHANGELOG entry when behaviour changes.
- Use plain language in the interface and the docs, and only numbers you measured.

## Reporting a problem

Open an issue. Say what you did, what you expected and what happened. For
security problems, see [SECURITY.md](SECURITY.md) instead.
