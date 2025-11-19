# xdefi.app

Swap (and future bridge) interface for Nuwa's x402x execution engine, built with
React, Vite, TypeScript, Tailwind CSS and shadcn/ui. Wallet connection is
handled via WalletConnect AppKit, wagmi and viem.

## Features

- Swap tokens across supported EVM networks using the OKX DEX Aggregator
- Wallet connection with AppKit (`@reown/appkit`) and wagmi/viem
- Settlement via the x402x facilitator service
- Responsive layout with animated swap UI
- Routes for Swap, Bridge (coming soon), FAQ and 404

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm or npm

### Install and run locally

```bash
# install dependencies
pnpm install    # or: npm install

# start dev server
pnpm dev        # or: npm run dev
```

Vite will start on http://localhost:5173 by default.

## Configuration

### Client (Vite) environment

Create a `.env.local` file in the project root (not committed) and set:

```bash
VITE_WALLETCONNECT_PROJECT_ID=your_walletconnect_project_id
```

Without this, wallet connect falls back to a demo project id and will log a
warning in the console.

For deployments under a sub-path (for example GitHub Pages), you can also set:

```bash
VITE_BASE_URL=/xdefi.app/
VITE_USE_HASH_ROUTE=true
```

These are wired into the `build:gh` script in `package.json`.

### Server (OKX proxy) environment

The `api/okx.ts` serverless function signs and forwards requests to the OKX Web3
DEX API. Configure the following environment variables in your deployment
environment (for example, Vercel project settings):

- `OKX_BASE_URL` (optional, defaults to `https://web3.okx.com`)
- `OKX_ACCESS_KEY`
- `OKX_SECRET_KEY`
- `OKX_PASSPHRASE`

If these are missing, the proxy responds with an error and quotes/swaps will
not work.

## Scripts

Common package scripts (see `package.json`):

- `dev` – start the Vite dev server
- `build` – type-check and build for production
- `preview` – preview the production build locally
- `lint` – run ESLint
- `build:gh` – build for deployment under a sub-path (for example GitHub Pages)

## Project Structure

```text
xdefi.app/
├── api/                 # Serverless functions (OKX proxy)
├── public/              # Public assets
├── src/                 # Application source code
│   ├── components/      # UI components (swap, layout, FAQ, nav, etc.)
│   ├── config/          # App and SEO configuration
│   ├── constants/       # Network, token and DEX hook metadata
│   ├── contexts/        # Theme and Web3 providers
│   ├── hooks/           # Swap quote, settlement and UI hooks
│   ├── lib/             # OKX client and utilities
│   ├── pages/           # Route-level pages (Swap, Bridge, FAQ, 404)
│   ├── App.tsx          # Application shell and router selection
│   ├── Router.tsx       # Route definitions
│   ├── main.tsx         # Entry point
│   └── index.css        # Tailwind and global styles
├── index.html           # HTML entry point
├── package.json         # Scripts and dependencies
├── tsconfig*.json       # TypeScript configuration
└── vite.config.ts       # Vite configuration
```

## Deployment

The frontend builds to static assets that can be hosted on any static platform
(for example, Vercel, Netlify or GitHub Pages). The OKX proxy in `api/okx.ts`
targets a Node serverless runtime compatible with `@vercel/node`; Vercel is
supported out of the box.

Update the `baseUrl` in `src/config/app.ts` and SEO settings in
`src/config/seo.ts` if your production domain changes.

## License

This project is licensed under the MIT License. See the `LICENSE` file for
details.
