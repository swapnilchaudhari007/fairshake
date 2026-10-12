# Contributing to Fairshake

Thanks for helping improve **Fairshake**, a PayPal escrow where AI checks delivered work line by line so clients pay only for what was delivered.

## Ways to contribute

- Report a bug or suggest an idea in [Issues](https://github.com/swapnilchaudhari007/fairshake/issues/new/choose)
- Pick up an issue labelled `good first issue` or `help wanted`
- Improve docs, examples or translations
- Review open pull requests

## Local setup

```bash
git clone https://github.com/<your-username>/fairshake.git
cd fairshake
npm install
cp .env.example .env   # PayPal sandbox + AI keys
npm run dev
```

Run the tests before opening a PR:

```bash
npm test
```

## Workflow

1. Fork the repo and create a branch: `git checkout -b feat/short-description`
2. Keep each PR focused on one change
3. Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`
4. Open a PR against `main` and fill in the template

## Areas you can work on

- PayPal escrow & payouts
- AI work review
- Milestones / scope
- UI / frontend

## AI-assisted contributions

AI tools are welcome. You are responsible for every line you submit: review it, test it and say in the PR if AI helped.

## Code of conduct

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please don't report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).
