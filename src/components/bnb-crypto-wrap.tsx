"use client";

// Wallet connection guard: use wagmi account state + AppKit modal
// Import the shared modal instance to open on demand without using the hook
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import AssetLogo from "@/components/asset-logo";
import {
  NATIVE_TOKEN_ADDRESS,
} from "@/constants/networks";
import { cn } from "@/lib/utils";
import { modal as appKitModal } from "@reown/appkit/react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  ArrowDown,
  CheckCircle,
  ChevronDown,
  Loader2,
  Settings,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
// no direct viem parsing here; handled inside hooks
import { useAccount, useBalance, useWriteContract, useWaitForTransactionReceipt, useReadContract, useChainId, useSwitchChain } from "wagmi";
import { parseUnits } from "viem";

interface Network {
  chainId: number; 
  name: string;
  wrapContract: string;
  usdcAddress: string;
  fromToken: Token;
  toToken: Token;
}

// Network configurations: Mainnet and Testnet
const NETWORK_CONFIG: Record<"mainnet" | "testnet", Network> = {
  mainnet: {
    chainId: 56,
    name: "BNB Smart Chain",
    wrapContract: "0x5a2dce590df31613c2945baf22c911992087af57", // 主网合约地址（需要替换为实际地址）
    usdcAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // BSC 主网 USDC
    fromToken: {
      symbol: "USDC",
      name: "USDC",
      balance: "0",
      price: 1,
      change24h: 0,
      address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      decimals: 18,
    },
    toToken: {
      symbol: "USDC",
      name: "USDC",
      balance: "0",
      price: 1,
      change24h: 0,
      address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      decimals: 18,
    },
  },
  testnet: {
    chainId: 97,
    name: "BNB Smart Chain Testnet",
    wrapContract: "0x5a2dce590df31613c2945baf22c911992087af57", // 测试网合约地址
    usdcAddress: "0x64544969ed7EBf5f083679233325356EbE738930", // BSC 测试网 USDC
    fromToken: {
      symbol: "USDC",
      name: "USDC",
      balance: "0",
      price: 1,
      change24h: 0,
      address: "0x64544969ed7EBf5f083679233325356EbE738930",
      decimals: 18,
    },
    toToken: {
      symbol: "USDC",
      name: "USDC",
      balance: "0",
      price: 1,
      change24h: 0,
      address: "0x221c5B1a293aAc1187ED3a7D7d2d9aD7fE1F3FB0",
      decimals: 18,
    },
  },
} as const;

// ERC20 ABI for approve and allowance
const ERC20_ABI = [
  {
    constant: false,
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    type: "function",
  },
] as const;

// Wrap Contract ABI
const WRAP_CONTRACT_ABI = [
  {
    inputs: [{ name: "amount", type: "uint256" }],
    name: "wrap",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

interface Token {
  symbol: string;
  name: string;
  // icon is unused now; we render with <AssetLogo/>
  icon?: string;
  // Optional remote token logo URL (e.g., from OKX)
  logoUrl?: string;
  balance: string;
  price: number;
  change24h: number;
  address: string;
  decimals?: number;
}

interface SwapState {
  fromNetwork: Network;
  toNetwork: Network;
  fromToken: Token;
  toToken: Token;
  fromAmount: string;
  toAmount: string;
  isLoading: boolean;
  status: "idle" | "loading" | "success" | "error";
  error?: string;
  // Last on-chain transaction details for the most recent swap attempt
  lastTxHash?: string;
  lastTxUrl?: string;
}

// Build networks from the SDK's supported list (constants are already filtered to mainnet only).
function buildNetworksFromSDK(selectedNetwork: "mainnet" | "testnet" = "testnet"): Network {
  return NETWORK_CONFIG[selectedNetwork];
}

// Internal base component used by the SwapComponent and BridgeComponent wrappers.
// Consumers should import/use the specific components instead of a generic "mode" prop.
function CryptoSwapBase() {
  const { isConnected, address } = useAccount();
  const currentChainId = useChainId();
  const { switchChainAsync, isPending: isSwitchingChain } = useSwitchChain();
  
  // Network selection state
  const [selectedNetwork, setSelectedNetwork] = useState<"mainnet" | "testnet">("testnet");
  
  const network = useMemo(() => buildNetworksFromSDK(selectedNetwork), [selectedNetwork]);
  
  // Get current network config
  const currentNetworkConfig = NETWORK_CONFIG[selectedNetwork];
  const WrapContract = currentNetworkConfig.wrapContract;
  // to networks come from API (mock hook for now). We'll compute after state init.
  const [swapState, setSwapState] = useState<SwapState>({
    fromNetwork: network,
    toNetwork: network, // temp init, will update once hook resolves
    fromToken: network.fromToken,
    // Default to the OKX-native address; metadata will be enriched when token list is fetched
    toToken: network.toToken,
    fromAmount: "",
    toAmount: "",
    isLoading: false,
    status: "idle",
  });

  // Amount editing is restricted to the 'from' side; 'to' is always derived.
  // no-op swap animation; we no longer flip from/to in UI
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [isHovering, setIsHovering] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  // Helpers to map our network ids to chainIds used by wagmi
  const chainId = currentNetworkConfig.chainId;
  
  // Check if wallet is on the correct network
  const isCorrectNetwork = currentChainId === chainId;
  
  // Handle network switch
  const handleNetworkSwitch = async () => {
    if (!isConnected) {
      try {
        await appKitModal?.open();
      } catch { }
      return;
    }
    
    if (!isCorrectNetwork) {
      try {
        await switchChainAsync({ chainId });
      } catch (error) {
        console.error("Failed to switch network:", error);
        setSwapState((prev) => ({
          ...prev,
          status: "error",
          error: "Failed to switch network. Please switch manually in your wallet.",
        }));
      }
    }
  };
  
  // Update swapState when network changes
  // useEffect(() => {
  //   const newNetwork = fromNetworks[0];
  //   if (newNetwork) {
  //     setSwapState((prev) => ({
  //       ...prev,
  //       fromNetwork: newNetwork,
  //       fromToken: newNetwork.tokens[0],
  //       toNetwork: newNetwork,
  //       toToken: newNetwork.tokens[0],
  //       fromAmount: "",
  //       toAmount: "",
  //       error: undefined,
  //     }));
  //   }
  // }, [fromNetworks]);

  // Auto-switch network when selected network changes (only if connected)
  useEffect(() => {
    if (isConnected && !isCorrectNetwork && !isSwitchingChain) {
      handleNetworkSwitch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNetwork]);

  // Determine whether the current tokens represent native assets (using the OKX
  // canonical "native" address). For native assets, wagmi's useBalance expects
  // `token` to be omitted/undefined so it queries the chain's native balance.
  const isFromTokenNative =
    swapState.fromToken?.address?.toLowerCase() ===
    NATIVE_TOKEN_ADDRESS.toLowerCase();
  const isToTokenNative =
    swapState.toToken?.address?.toLowerCase() ===
    NATIVE_TOKEN_ADDRESS.toLowerCase();

  // Check current allowance for the wrap contract
  const tokenAddressForAllowance = swapState.fromToken?.address
    ? (swapState.fromToken.address.startsWith("0x")
        ? (swapState.fromToken.address as `0x${string}`)
        : (`0x${swapState.fromToken.address}` as `0x${string}`))
    : undefined;
  
  const { data: allowance } = useReadContract({
    address: tokenAddressForAllowance,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address && WrapContract ? [address, WrapContract as `0x${string}`] : undefined,
    chainId: chainId,
    query: {
      enabled: Boolean(
        isConnected &&
        address &&
        tokenAddressForAllowance &&
        !isFromTokenNative &&
        chainId,
      ),
    },
  });
  console.log("allowance", allowance);

  // Write contract hooks
  const { writeContract: approveToken, data: approveHash, isPending: isApproving, error: approveError } = useWriteContract();
  const { writeContract: wrapToken, data: wrapHash, isPending: isWrapping } = useWriteContract();

  console.log("approveError", approveError);
  console.log("approveHash", approveHash);

  // Wait for approve transaction
  const { isLoading: isWaitingApprove, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({
    hash: approveHash,
    chainId: chainId,
  });

  // Wait for wrap transaction
  const { isLoading: isWaitingWrap, isSuccess: isWrapSuccess } = useWaitForTransactionReceipt({
    hash: wrapHash,
    chainId: chainId,
  });

  // Live balances from connected wallet for selected tokens
  // - ERC-20 tokens: pass token address
  // - Native token (0xEeee... sentinel): omit token so wagmi reads native balance
  // We scope reads to the currently selected tokens to avoid spamming RPCs.
  const fromBalance = useBalance({
    address,
    token: isFromTokenNative
      ? undefined
      : (swapState.fromToken?.address as `0x${string}`),
    chainId: chainId,
    query: {
      enabled: Boolean(
        isConnected &&
        address &&
        chainId &&
        // For native balance reads, we only require that the token is marked native
        (isFromTokenNative || swapState.fromToken?.address),
      ),
    },
  });
  const toBalance = useBalance({
    address,
    token: isToTokenNative
      ? undefined
      : (swapState.toToken?.address as `0x${string}`),
    chainId: Number(chainId),
    query: {
      enabled: Boolean(
        isConnected &&
        address &&
        chainId &&
        (isToTokenNative || swapState.toToken?.address),
      ),
    },
  });

  // Render-friendly string (trim trailing zeros, keep a few decimals)
  function fmtBalance(v?: string): string {
    if (!v) return "0";
    const [ints, decs = ""] = String(v).split(".");
    const trimmed = decs.replace(/0+$/, "").slice(0, 6); // max 6 decimals
    return trimmed ? `${ints}.${trimmed}` : ints;
  }

  // Shorten long hex strings (e.g., transaction hashes) for display
  function shortHex(v?: string, visibleChars = 4): string {
    if (!v) return "";
    if (v.length <= 2 + visibleChars * 2) return v;
    return `${v.slice(0, 2 + visibleChars)}…${v.slice(-visibleChars)}`;
  }

  // Mouse tracking for glow effects
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setMousePosition({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
      }
    };

    if (isHovering) {
      document.addEventListener("mousemove", handleMouseMove);
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
    };
  }, [isHovering]);


  // Handle approve success - automatically call wrap
  useEffect(() => {
    if (isApproveSuccess && swapState.fromAmount && address) {
      const decimals = swapState.fromToken?.decimals ?? 18;
      const amountRaw = parseUnits(swapState.fromAmount, decimals);
      
      wrapToken({
        address: WrapContract as `0x${string}`,
        abi: WRAP_CONTRACT_ABI,
        functionName: "wrap",
        args: [amountRaw],
        chainId: chainId,
      });
    }
  }, [isApproveSuccess, swapState.fromAmount, address, swapState.fromToken?.decimals, wrapToken, chainId]);

  // Handle wrap success
  useEffect(() => {
    if (isWrapSuccess) {
      setSwapState((prev) => ({
        ...prev,
        status: "success",
        isLoading: false,
        error: undefined,
        lastTxHash: wrapHash,
      }));
      // Reset form after 2 seconds
      const timer = setTimeout(() => {
        setSwapState((prev) => ({
          ...prev,
          fromAmount: "",
          toAmount: "",
          status: "idle",
        }));
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [isWrapSuccess, wrapHash]);

  const handleSwap = async () => {
    console.log("handleSwap");
    if (!swapState.fromAmount || Number(swapState.fromAmount) <= 0) return;
    if (!isConnected) {
      try {
        await appKitModal?.open();
      } catch { }
      return;
    }

    // Check if wallet is on the correct network
    if (!isCorrectNetwork) {
      setSwapState((prev) => ({
        ...prev,
        status: "error",
        error: `Please switch to ${currentNetworkConfig.name} (Chain ID: ${chainId})`,
      }));
      // Try to switch network automatically
      handleNetworkSwitch();
      return;
    }

    if (!address || !swapState.fromToken?.address) {
      setSwapState((prev) => ({
        ...prev,
        status: "error",
        error: "Missing wallet address or token address",
      }));
      return;
    }

    // Skip approval for native tokens
    if (isFromTokenNative) {
      setSwapState((prev) => ({
        ...prev,
        status: "error",
        error: "Native tokens cannot be wrapped using this contract",
      }));
      return;
    }

    // Set loading state
    setSwapState((prev) => ({
      ...prev,
      isLoading: true,
      status: "loading",
      error: undefined,
    }));

    try {
      const decimals = swapState.fromToken.decimals ?? 18;
      const amountRaw = parseUnits(swapState.fromAmount, decimals);
      const amountBigInt = BigInt(amountRaw.toString());

      // Ensure token address has 0x prefix
      const tokenAddress = swapState.fromToken.address.startsWith("0x")
        ? (swapState.fromToken.address as `0x${string}`)
        : (`0x${swapState.fromToken.address}` as `0x${string}`);

      // Check if we need to approve
      const currentAllowance = allowance ? BigInt(allowance.toString()) : 0n;
      
      if (currentAllowance < amountBigInt) {
        // Need to approve first
        approveToken({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [WrapContract as `0x${string}`, amountBigInt],
          chainId: chainId,
        });
      } else {
        // Already approved, call wrap directly
        wrapToken({
          address: WrapContract as `0x${string}`,
          abi: WRAP_CONTRACT_ABI,
          functionName: "wrap",
          args: [amountBigInt],
          chainId: chainId,
        });
      }
    } catch (error) {
      setSwapState((prev) => ({
        ...prev,
        status: "error",
        isLoading: false,
        error: error instanceof Error ? error.message : "Transaction failed",
      }));
    }
  };

  const containerVariants = {
    hidden: { opacity: 0, y: 20, scale: 0.95 },
    visible: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: {
        type: "spring" as const,
        stiffness: 300,
        damping: 30,
        staggerChildren: 0.1,
        delayChildren: 0.1,
      },
    },
  } as const;

  const itemVariants = {
    hidden: { opacity: 0, x: -20, filter: "blur(4px)" },
    visible: {
      opacity: 1,
      x: 0,
      filter: "blur(0px)",
      transition: {
        type: "spring" as const,
        stiffness: 400,
        damping: 28,
        mass: 0.6,
      },
    },
  } as const;

  const glowVariants = {
    idle: { opacity: 0 },
    hover: {
      opacity: 1,
      transition: { duration: 0.3 },
    },
  };

  return (
    <div className="bg-background flex items-center justify-center p-4">
      <motion.div
        ref={containerRef}
        className="relative w-full max-w-md"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        {/* Animated background glow */}
        <motion.div
          className="absolute inset-0 bg-gradient-to-r from-blue-500/20 via-purple-500/20 to-pink-500/20 rounded-3xl blur-xl"
          variants={glowVariants}
          animate={isHovering ? "hover" : "idle"}
          style={{
            background: isHovering
              ? `radial-gradient(circle at ${mousePosition.x}px ${mousePosition.y}px, rgba(59, 130, 246, 0.3) 0%, rgba(147, 51, 234, 0.2) 50%, transparent 70%)`
              : undefined,
          }}
        />

        {/* Main swap container */}
        <motion.div
          className="relative bg-card/80 backdrop-blur-xl border border-border/50 rounded-3xl p-6 shadow-2xl"
          variants={itemVariants}
        >
          {/* Header */}
          <motion.div
            className="flex items-center justify-between mb-6"
            variants={itemVariants}
          >
            <div className="flex items-center gap-3">
              <motion.div
                className="w-10 h-10 bg-gradient-to-r from-blue-500 to-purple-600 rounded-xl flex items-center justify-center"
                whileHover={{ scale: 1.1, rotate: 5 }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
              >
                <Zap className="w-5 h-5 text-white" />
              </motion.div>
              <div>
                <h1 className="text-xl font-bold text-foreground">Wrap</h1>
                <p className="text-sm text-muted-foreground">
                  Wrap tokens instantly
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Network Switcher */}
              <motion.div
                className="flex items-center gap-1 bg-muted/50 rounded-lg p-1"
                whileHover={{ scale: 1.02 }}
              >
                <motion.button
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm font-medium transition-all",
                    selectedNetwork === "testnet"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => setSelectedNetwork("testnet")}
                  disabled={isSwitchingChain}
                >
                  Testnet
                </motion.button>
                <motion.button
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm font-medium transition-all",
                    selectedNetwork === "mainnet"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => setSelectedNetwork("mainnet")}
                  disabled={isSwitchingChain}
                >
                  Mainnet
                </motion.button>
              </motion.div>

            </div>
          </motion.div>

          {/* Network Warning */}
          {isConnected && !isCorrectNetwork && (
            <motion.div
              className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="flex items-center gap-2 text-sm">
                <AlertCircle className="w-4 h-4 text-yellow-500" />
                <span className="text-yellow-600 dark:text-yellow-400">
                  Please switch to {currentNetworkConfig.name} (Chain ID: {chainId})
                </span>
                {isSwitchingChain && (
                  <Loader2 className="w-4 h-4 animate-spin text-yellow-500" />
                )}
              </div>
            </motion.div>
          )}

          {/* From Token */}
          <motion.div className="relative mb-2" variants={itemVariants}>
            <div className="bg-muted/30 rounded-2xl p-4 border border-border/30">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-muted-foreground">From</span>
                <span className="text-sm text-muted-foreground">
                  Balance:{" "}
                  {fmtBalance(fromBalance.data?.formatted) ||
                    swapState.fromToken.balance}
                </span>
              </div>

              <div className="flex items-center gap-3 min-w-0">
                <motion.button
                  className="flex items-start gap-2 bg-background/50 rounded-xl px-3 py-2 hover:bg-background/80 transition-colors shrink-0"
                >
                  <AssetLogo
                    kind="token"
                    id={swapState.fromToken.symbol}
                    size={36}
                    src={swapState.fromToken.logoUrl}
                  />
                  <div className="flex flex-col leading-tight items-start justify-start">
                    <span className="font-semibold">
                      {swapState.fromToken.symbol}
                    </span>
                    <span className="text-xs text-muted-foreground flex items-center gap-2">
                      <span className="truncate max-w-[8rem] sm:max-w-[10rem]">
                        {swapState.fromNetwork.name}
                      </span>
                    </span>
                  </div>
                </motion.button>

                <input
                  type="number"
                  placeholder="0.0"
                  value={swapState.fromAmount}
                  onChange={(e) => {
                    const value = e.target.value;
                    setSwapState((prev) => ({
                      ...prev,
                      fromAmount: value,
                      toAmount: value,
                      // Clear any previous swap result/error message when user edits amount
                      error: undefined,
                      lastTxHash: undefined,
                      lastTxUrl: undefined,
                    }));
                  }}
                  className="min-w-0 flex-1 bg-transparent text-right text-2xl font-semibold outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>
          </motion.div>

          {/* Swap Button */}
          <motion.div
            className="flex justify-center -my-1 relative z-10"
            variants={itemVariants}
          >
            <motion.div
              className="w-12 h-12 bg-gradient-to-r from-blue-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg"
              whileTap={{ scale: 0.9 }}
              transition={{ type: "spring", stiffness: 300, damping: 25 }}
            >
              <ArrowDown className="w-5 h-5 text-white" onClick={() => {
                console.log("arrow down");
              }}/>
            </motion.div>
          </motion.div>

          {/* To Token */}
          <motion.div className="relative mb-6" variants={itemVariants}>
            <div className="bg-muted/30 rounded-2xl p-4 border border-border/30">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-muted-foreground">To</span>
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  {false && (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Loading assets…</span>
                    </>
                  )}
                  {true && (
                    <>
                      Balance:{" "}
                      {fmtBalance(toBalance.data?.formatted) ||
                        swapState.toToken.balance}
                    </>
                  )}
                </span>
              </div>

              <div className="flex items-center gap-3 min-w-0">
                {false ? (
                  <div className="min-w-0 flex-1 text-right text-2xl font-semibold text-muted-foreground inline-flex items-center justify-end gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Estimating…</span>
                  </div>
                ) : (
                  <>
                  <motion.button
                  className="flex items-start gap-2 bg-background/50 rounded-xl px-3 py-2 hover:bg-background/80 transition-colors shrink-0"
                >
                  <AssetLogo
                    kind="token"
                    id={swapState.fromToken.symbol}
                    size={36}
                    src={swapState.fromToken.logoUrl}
                  />
                  <div className="flex flex-col leading-tight items-start justify-start">
                    <span className="font-semibold">
                      {swapState.fromToken.symbol}
                    </span>
                    <span className="text-xs text-muted-foreground flex items-center gap-2">
                      <span className="truncate max-w-[8rem] sm:max-w-[10rem]">
                        {swapState.fromNetwork.name}
                      </span>
                    </span>
                  </div>
                </motion.button>
                <input
                    type="text"
                    placeholder="0.0"
                    value={swapState.toAmount}
                    readOnly
                    aria-readonly="true"
                    className="min-w-0 flex-1 bg-transparent text-right text-2xl font-semibold outline-none placeholder:text-muted-foreground cursor-default"
                  />
                </>
                  
                )}
              </div>
            </div>
          </motion.div>

          {/* Swap Button */}
          <motion.button
            className={cn(
              "w-full py-4 rounded-2xl font-semibold text-lg transition-all duration-300",
              swapState.status === "success"
                ? "bg-green-500 text-white"
                : swapState.status === "error"
                  ? "bg-red-500 text-white"
                  : swapState.isLoading
                    ? "bg-muted text-muted-foreground cursor-not-allowed"
                    : !swapState.fromAmount || Number(swapState.fromAmount) <= 0
                      ? "bg-muted text-muted-foreground cursor-not-allowed"
                      : "bg-gradient-to-r from-blue-500 to-purple-600 text-white hover:from-blue-600 hover:to-purple-700",
            )}
            whileHover={
              !swapState.isLoading && swapState.fromAmount
                ? { scale: 1.02 }
                : {}
            }
            whileTap={
              !swapState.isLoading && swapState.fromAmount
                ? { scale: 0.98 }
                : {}
            }
            disabled={
              swapState.isLoading ||
              isApproving ||
              isWrapping ||
              isWaitingApprove ||
              isWaitingWrap ||
              !swapState.fromAmount ||
              Number(swapState.fromAmount) <= 0
            }
            onClick={handleSwap}
            variants={itemVariants}
          >
            <div className="flex items-center justify-center gap-2">
              {!isConnected ? (
                <>Connect Wallet</>
              ) : swapState.isLoading || isApproving || isWrapping || isWaitingApprove || isWaitingWrap ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {isApproving || isWaitingApprove ? "Approving..." : isWrapping || isWaitingWrap ? "Wrapping..." : "Processing..."}
                </>
              ) : swapState.status === "success" ? (
                <>
                  <CheckCircle className="w-5 h-5" />
                  Wwap Successful!
                </>
              ) : swapState.status === "error" ? (
                <>
                  <AlertCircle className="w-5 h-5" />
                  Try Again
                </>
              ) : !swapState.fromAmount || Number(swapState.fromAmount) <= 0 ? (
                "Enter an amount"
              ) : (
                <>
                  <Zap className="w-5 h-5" />
                  Wrap Tokens
                </>
              )}
            </div>
          </motion.button>
          {(swapState.error || swapState.lastTxHash) && (
            <div className="mt-2 text-sm text-center break-words">
              {swapState.error && (
                <div className="text-red-500 mb-1">
                  {String(swapState.error)}
                </div>
              )}
              {swapState.lastTxHash && (
                <div className="text-muted-foreground">
                  Your transaction hash:{" "}
                  {swapState.lastTxUrl ? (
                    <a
                      href={swapState.lastTxUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline font-mono"
                    >
                      {shortHex(swapState.lastTxHash)}
                    </a>
                  ) : (
                    <span className="font-mono">
                      {shortHex(swapState.lastTxHash)}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </motion.div>
      </motion.div>
    </div>
  );
}

// Public: swap-only component
export function SwapComponent() {
  return <CryptoSwapBase />;
}
