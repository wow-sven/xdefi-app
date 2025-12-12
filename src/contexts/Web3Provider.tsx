import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { base, xLayer } from "@reown/appkit/networks";
import { AppKitProvider } from "@reown/appkit/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type PropsWithChildren, useMemo } from "react";
import { WagmiProvider } from "wagmi";
import { defineChain } from "viem";

// Initialize AppKit + Wagmi adapter
const appKitProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as
  | string
  | undefined;
if (!appKitProjectId) {
  // eslint-disable-next-line no-console
  console.warn(
    "Missing VITE_WALLETCONNECT_PROJECT_ID. Wallet connect will not work until it is set.",
  );
}

// Custom RPC endpoints (optional, from environment variables)
// If not set, will use default RPC from @reown/appkit/networks
const BASE_RPC_URL = import.meta.env.VITE_BASE_RPC_URL;
const XLAYER_RPC_URL = import.meta.env.VITE_XLAYER_RPC_URL;
const BNB_CHAIN_MAINNET_RPC_URL = import.meta.env.VITE_BNB_CHAIN_MAINNET_RPC_URL || "https://bsc-dataseed1.binance.org";
const BNB_CHAIN_TESTNET_RPC_URL = import.meta.env.VITE_BNB_CHAIN_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";

// BNB Chain Mainnet (Chain ID 56)
const bnbChainMainnet = defineChain({
  id: 56,
  name: "BNB Smart Chain",
  nativeCurrency: {
    decimals: 18,
    name: "BNB",
    symbol: "BNB",
  },
  rpcUrls: {
    default: {
      http: [BNB_CHAIN_MAINNET_RPC_URL],
    },
    public: {
      http: [BNB_CHAIN_MAINNET_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "BscScan",
      url: "https://bscscan.com",
    },
  },
  testnet: false,
});

// BNB Chain Testnet (Chain ID 97)
const bnbChainTestnet = defineChain({
  id: 97,
  name: "BNB Smart Chain Testnet",
  nativeCurrency: {
    decimals: 18,
    name: "BNB",
    symbol: "BNB",
  },
  rpcUrls: {
    default: {
      http: [BNB_CHAIN_TESTNET_RPC_URL],
    },
    public: {
      http: [BNB_CHAIN_TESTNET_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "BscScan",
      url: "https://testnet.bscscan.com",
    },
  },
  testnet: true,
});

// Create network configurations with custom RPC if provided
const baseNetwork = BASE_RPC_URL
  ? {
      ...base,
      rpcUrls: {
        default: {
          http: [BASE_RPC_URL],
        },
        public: {
          http: [BASE_RPC_URL],
        },
      },
    }
  : base;

const xLayerNetwork = XLAYER_RPC_URL
  ? {
      ...xLayer,
      rpcUrls: {
        default: {
          http: [XLAYER_RPC_URL],
        },
        public: {
          http: [XLAYER_RPC_URL],
        },
      },
    }
  : xLayer;

const appNetworks = [baseNetwork, xLayerNetwork, bnbChainMainnet, bnbChainTestnet] as unknown as [any, ...any[]];
const wagmiAdapter = new WagmiAdapter({
  networks: appNetworks,
  projectId: appKitProjectId ?? "demo",
});

const queryClient = new QueryClient();

export function Web3Provider({ children }: PropsWithChildren) {
  const qc = useMemo(() => queryClient, []);
  return (
    <WagmiProvider config={wagmiAdapter.wagmiConfig}>
      <AppKitProvider
        projectId={appKitProjectId ?? "demo"}
        adapters={[wagmiAdapter] as any}
        networks={appNetworks as any}
        defaultNetwork={base as any}
        metadata={{
          name: "xdefi.app",
          description: "xdefi.app — Swap & Bridge",
          url: "http://localhost:5173",
          icons: ["https://avatars.githubusercontent.com/u/13698671?s=200&v=4"],
        }}
        features={{
          analytics: false,
          emailShowWallets: false,
          swaps: false,
        }}
      >
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </AppKitProvider>
    </WagmiProvider>
  );
}
