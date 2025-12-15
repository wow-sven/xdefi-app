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
  ArrowLeftRight,
  CheckCircle,
  Loader2,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
// no direct viem parsing here; handled inside hooks
import { useAccount, useBalance, useWriteContract, useWaitForTransactionReceipt, useReadContract, useChainId, useSwitchChain } from "wagmi";
import { parseUnits, maxUint256 } from "viem";

interface Network {
  chainId: number; 
  name: string;
  wrapContract: string;
  usdcAddress: string;
  fromToken: Token;
  toToken: Token;
  scan: string;
}

// Network configurations: Mainnet and Testnet
const NETWORK_CONFIG: Record<"mainnet" | "testnet", Network> = {
  mainnet: {
    chainId: 56,
    name: "BNB Smart Chain",
    wrapContract: "0x5a2dce590df31613c2945baf22c911992087af57", // 主网合约地址（需要替换为实际地址）
    usdcAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // BSC 主网 USDC
    scan: "https://bscscan.com/tx",
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
    wrapContract: "0xb4BE1a12A1d4Aac09974586027D95F51419d68B6", // 测试网合约地址
    usdcAddress: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd", // BSC 测试网 USDT
    scan: "https://testnet.bscscan.com/tx",
    fromToken: {
      symbol: "USDT",
      name: "USDT",
      balance: "0",
      price: 1,
      change24h: 0,
      address: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
      decimals: 18,
    },
    toToken: {
      symbol: "USDTX",
      name: "USDtX",
      balance: "0",
      price: 1,
      change24h: 0,
      address: "0xb4BE1a12A1d4Aac09974586027D95F51419d68B6",
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
  {
    inputs: [{ name: "amount", type: "uint256" }],
    name: "unwrap",
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
  
  // Wrap/Unwrap mode state
  const [isWrapMode, setIsWrapMode] = useState<boolean>(true); // true = wrap, false = unwrap
  
  const network = useMemo(() => buildNetworksFromSDK(selectedNetwork), [selectedNetwork]);
  
  // Get current network config
  const currentNetworkConfig = NETWORK_CONFIG[selectedNetwork];
  const WrapContract = currentNetworkConfig.wrapContract;
  
  // Determine tokens based on mode
  // Wrap: fromToken (USDC) -> toToken (wrapped USDC)
  // Unwrap: fromToken (wrapped USDC) -> toToken (USDC)
  const fromToken = isWrapMode ? network.fromToken : network.toToken;
  const toToken = isWrapMode ? network.toToken : network.fromToken;
  
  // to networks come from API (mock hook for now). We'll compute after state init.
  const [swapState, setSwapState] = useState<SwapState>({
    fromNetwork: network,
    toNetwork: network, // temp init, will update once hook resolves
    fromToken: fromToken,
    toToken: toToken,
    fromAmount: "",
    toAmount: "",
    isLoading: false,
    status: "idle",
  });
  
  // Update tokens when mode changes
  useEffect(() => {
    setSwapState((prev) => ({
      ...prev,
      fromToken: isWrapMode ? network.fromToken : network.toToken,
      toToken: isWrapMode ? network.toToken : network.fromToken,
      fromAmount: "",
      toAmount: "",
      error: undefined,
    }));
  }, [isWrapMode, network]);

  // Amount editing is restricted to the 'from' side; 'to' is always derived.
  // no-op swap animation; we no longer flip from/to in UI
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [isHovering, setIsHovering] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const prevApprovingRef = useRef(false);
  const prevWrappingRef = useRef(false);
  const hasCalledWrapAfterApproveRef = useRef(false);

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
  
  // Only check allowance in wrap mode (unwrap doesn't need approval)
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
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
        chainId &&
        isWrapMode, // Only check allowance in wrap mode
      ),
    },
  });

  // Write contract hooks
  const { writeContract: approveToken, data: approveHash, isPending: isApproving, error: approveError } = useWriteContract();
  const { writeContract: wrapOrUnwrapToken, data: wrapHash, isPending: isWrapping, error: wrapError } = useWriteContract();

  // Wait for approve transaction
  const { isLoading: isWaitingApprove, isSuccess: isApproveSuccess, isError: isApproveReceiptError, error: approveReceiptError } = useWaitForTransactionReceipt({
    hash: approveHash,
    chainId: chainId,
  });

  // Wait for wrap transaction
  const { isLoading: isWaitingWrap, isSuccess: isWrapSuccess, isError: isWrapReceiptError, error: wrapReceiptError } = useWaitForTransactionReceipt({
    hash: wrapHash,
    chainId: chainId,
  });

  // Handle approve errors (user rejection, transaction failure, etc.)
  useEffect(() => {
    if (approveError) {
      const errorMessage = approveError.message || String(approveError);
      const isUserRejected = 
        errorMessage.toLowerCase().includes('user rejected') ||
        errorMessage.toLowerCase().includes('user denied') ||
        errorMessage.toLowerCase().includes('rejected') ||
        errorMessage.toLowerCase().includes('cancelled') ||
        errorMessage.toLowerCase().includes('action rejected');
      
      // Check for RPC errors
      const isRpcError = 
        errorMessage.toLowerCase().includes('rpc endpoint') ||
        errorMessage.toLowerCase().includes('http client error') ||
        errorMessage.toLowerCase().includes('network error') ||
        errorMessage.toLowerCase().includes('fetch failed') ||
        errorMessage.toLowerCase().includes('timeout');
      
      let displayError = "";
      if (isUserRejected) {
        displayError = "Transaction cancelled by user";
      } else if (isRpcError) {
        displayError = `RPC connection error. Please check your network connection and try again. If the problem persists, the RPC endpoint may be temporarily unavailable.`;
      } else {
        displayError = `Approval failed: ${errorMessage}`;
      }
      
      setSwapState((prev) => ({
        ...prev,
        isLoading: false,
        status: "error",
        error: displayError,
      }));
    }
  }, [approveError]);

  // Handle wrap/unwrap errors (user rejection, transaction failure, etc.)
  useEffect(() => {
    if (wrapError) {
      // Reset the flag on error so user can retry
      hasCalledWrapAfterApproveRef.current = false;
      const errorMessage = wrapError.message || String(wrapError);
      const isUserRejected = 
        errorMessage.toLowerCase().includes('user rejected') ||
        errorMessage.toLowerCase().includes('user denied') ||
        errorMessage.toLowerCase().includes('rejected') ||
        errorMessage.toLowerCase().includes('cancelled') ||
        errorMessage.toLowerCase().includes('action rejected');
      
      // Check for RPC errors
      const isRpcError = 
        errorMessage.toLowerCase().includes('rpc endpoint') ||
        errorMessage.toLowerCase().includes('http client error') ||
        errorMessage.toLowerCase().includes('network error') ||
        errorMessage.toLowerCase().includes('fetch failed') ||
        errorMessage.toLowerCase().includes('timeout');
      
      let displayError = "";
      if (isUserRejected) {
        displayError = "Transaction cancelled by user";
      } else if (isRpcError) {
        displayError = `RPC connection error. Please check your network connection and try again. If the problem persists, the RPC endpoint may be temporarily unavailable.`;
      } else {
        displayError = `${isWrapMode ? 'Wrap' : 'Unwrap'} failed: ${errorMessage}`;
      }
      
      setSwapState((prev) => ({
        ...prev,
        isLoading: false,
        status: "error",
        error: displayError,
      }));
    }
  }, [wrapError, isWrapMode]);

  // Handle approve transaction receipt errors
  useEffect(() => {
    if (isApproveReceiptError && approveReceiptError) {
      const errorMessage = approveReceiptError.message || String(approveReceiptError);
      
      // Check for RPC errors
      const isRpcError = 
        errorMessage.toLowerCase().includes('rpc endpoint') ||
        errorMessage.toLowerCase().includes('http client error') ||
        errorMessage.toLowerCase().includes('network error') ||
        errorMessage.toLowerCase().includes('fetch failed') ||
        errorMessage.toLowerCase().includes('timeout');
      
      const displayError = isRpcError
        ? `RPC connection error while checking transaction status. The transaction may have been submitted. Please check the blockchain explorer.`
        : `Approval transaction failed: ${errorMessage}`;
      
      setSwapState((prev) => ({
        ...prev,
        isLoading: false,
        status: "error",
        error: displayError,
      }));
    }
  }, [isApproveReceiptError, approveReceiptError]);

  // Handle wrap transaction receipt errors
  useEffect(() => {
    if (isWrapReceiptError && wrapReceiptError) {
      const errorMessage = wrapReceiptError.message || String(wrapReceiptError);
      
      // Check for RPC errors
      const isRpcError = 
        errorMessage.toLowerCase().includes('rpc endpoint') ||
        errorMessage.toLowerCase().includes('http client error') ||
        errorMessage.toLowerCase().includes('network error') ||
        errorMessage.toLowerCase().includes('fetch failed') ||
        errorMessage.toLowerCase().includes('timeout');
      
      const displayError = isRpcError
        ? `RPC connection error while checking transaction status. The transaction may have been submitted. Please check the blockchain explorer.`
        : `Transaction failed: ${errorMessage}`;
      
      setSwapState((prev) => ({
        ...prev,
        isLoading: false,
        status: "error",
        error: displayError,
      }));
    }
  }, [isWrapReceiptError, wrapReceiptError]);

  // Handle case where isPending becomes false without success or error (user cancellation without error)
  useEffect(() => {
    // Track when isPending transitions from true to false
    const wasApproving = prevApprovingRef.current;
    const wasWrapping = prevWrappingRef.current;
    
    // If we were pending and now we're not, and no hash was generated, likely cancelled
    if (wasApproving && !isApproving && !approveHash && !isApproveSuccess && !approveError && swapState.isLoading) {
      setSwapState((prev) => ({
        ...prev,
        isLoading: false,
        status: "error",
        error: "Approval was cancelled",
      }));
    }
    
    if (wasWrapping && !isWrapping && !wrapHash && !isWrapSuccess && !wrapError && swapState.isLoading) {
      setSwapState((prev) => ({
        ...prev,
        isLoading: false,
        status: "error",
        error: `${isWrapMode ? 'Wrap' : 'Unwrap'} was cancelled`,
      }));
    }
    
    // Update refs
    prevApprovingRef.current = isApproving;
    prevWrappingRef.current = isWrapping;
  }, [isApproving, isWrapping, approveHash, wrapHash, isApproveSuccess, isWrapSuccess, approveError, wrapError, swapState.isLoading, isWrapMode]);

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
  
  // Get refetch functions for balance updates
  const refetchFromBalance = fromBalance.refetch;
  const refetchToBalance = toBalance.refetch;

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


  // Handle approve success - automatically call wrap/unwrap
  useEffect(() => {
    // Only call wrap once after approve succeeds, and only if we haven't already called it
    if (isApproveSuccess && swapState.fromAmount && address && isWrapMode && isCorrectNetwork && !hasCalledWrapAfterApproveRef.current && !wrapHash) {
      const decimals = swapState.fromToken?.decimals ?? 18;
      const amountRaw = parseUnits(swapState.fromAmount, decimals);
      const amountBigInt = BigInt(amountRaw.toString());
      
      // Wait for allowance to update on-chain, then verify it's sufficient before calling wrap
      const checkAndWrap = async () => {
        let retries = 0;
        const maxRetries = 5;
        
        while (retries < maxRetries) {
          // Refetch allowance to get the latest value
          const { data: latestAllowance } = await refetchAllowance();
          const currentAllowance = latestAllowance ? BigInt(latestAllowance.toString()) : 0n;
          
          // Check if allowance is sufficient - use amountRaw (the actual value being wrapped)
          // Note: amountRaw and amountBigInt should be the same, but we use amountRaw to be safe
          const wrapAmount = BigInt(amountRaw.toString());
          
          // Some contracts may require slightly more allowance due to internal calculations or rounding
          // Add a small buffer (0.1%) to account for any precision issues or contract requirements
          // This matches the approval buffer we use when approving
          const requiredAllowance = (wrapAmount * 1001n) / 1000n;
          
          // Verify the allowance is sufficient with a small margin for safety
          // We check >= requiredAllowance to ensure we have enough, even with potential rounding
          if (currentAllowance >= requiredAllowance) {
            // Mark that we've called wrap to prevent duplicate calls
            hasCalledWrapAfterApproveRef.current = true;
            
            try {
              wrapOrUnwrapToken({
                address: WrapContract as `0x${string}`,
                abi: WRAP_CONTRACT_ABI,
                functionName: "wrap",
                args: [wrapAmount],
                chainId: chainId,
              });
            } catch (error) {
              // Reset the flag on error so user can retry
              hasCalledWrapAfterApproveRef.current = false;
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.error("Wrap call error:", error);
              setSwapState((prev) => ({
                ...prev,
                isLoading: false,
                status: "error",
                error: `Failed to initiate wrap: ${errorMessage}`,
              }));
            }
            return; // Success, exit the retry loop
          } else {
            const requiredAllowance = (wrapAmount * 1001n) / 1000n;
            console.warn("Allowance insufficient:", {
              currentAllowance: currentAllowance.toString(),
              wrapAmount: wrapAmount.toString(),
              requiredAllowance: requiredAllowance.toString(),
              difference: currentAllowance >= wrapAmount 
                ? "0 (exact match, but buffer needed)" 
                : (wrapAmount - currentAllowance).toString(),
            });
          }
          
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
          retries++;
        }
        
        // If we've exhausted retries and allowance is still insufficient
        hasCalledWrapAfterApproveRef.current = false;
        setSwapState((prev) => ({
          ...prev,
          isLoading: false,
          status: "error",
          error: `Allowance insufficient. Current: ${allowance?.toString() || "0"}, Required: ${amountBigInt.toString()}. Please try approving again.`,
        }));
      };
      
      // Start checking after a short delay to allow blockchain state to update
      const timer = setTimeout(() => {
        checkAndWrap();
      }, 1000);
      
      return () => clearTimeout(timer);
    }
  }, [isApproveSuccess, swapState.fromAmount, address, swapState.fromToken?.decimals, wrapOrUnwrapToken, chainId, isWrapMode, isCorrectNetwork, wrapHash, refetchAllowance]);

  // Handle wrap success
  useEffect(() => {
    if (isWrapSuccess) {
      // Reset the flag when wrap succeeds
      hasCalledWrapAfterApproveRef.current = false;
      setSwapState((prev) => ({
        ...prev,
        status: "success",
        isLoading: false,
        error: undefined,
        lastTxHash: wrapHash,
      }));
      
      // Refresh balances after a short delay to allow blockchain state to update
      const refreshBalances = async () => {
        // Wait a bit for the blockchain state to update
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Refetch both balances
        await Promise.all([
          refetchFromBalance(),
          refetchToBalance(),
        ]);
      };
      refreshBalances();
      
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
  }, [isWrapSuccess, wrapHash, refetchFromBalance, refetchToBalance]);

  const handleSwap = async () => {
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

    // Reset the wrap call flag when starting a new swap
    hasCalledWrapAfterApproveRef.current = false;
    
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

      if (isWrapMode) {
        // Wrap mode: need to approve first
        // Ensure token address has 0x prefix
        const tokenAddress = swapState.fromToken.address.startsWith("0x")
          ? (swapState.fromToken.address as `0x${string}`)
          : (`0x${swapState.fromToken.address}` as `0x${string}`);

        // Check if we need to approve
        const currentAllowance = allowance ? BigInt(allowance.toString()) : 0n;
        
        // Debug logging
        console.log("Wrap check:", {
          currentAllowance: currentAllowance.toString(),
          amountBigInt: amountBigInt.toString(),
          amountRaw: amountRaw.toString(),
          wrapContract: WrapContract,
          tokenAddress: tokenAddress,
          fromAmount: swapState.fromAmount,
          decimals: decimals,
        });
        
        // Approve maximum amount (type(uint256).max) to avoid needing to re-approve for each transaction
        // This is a common pattern in DeFi and allows the contract to use any amount up to the user's balance
        const maxApproval = maxUint256;
        
        if (currentAllowance < amountBigInt) {
          // Reset the flag when starting a new approve
          hasCalledWrapAfterApproveRef.current = false;
          // Approve maximum amount for convenience - user won't need to approve again
          console.log("Approving maximum amount:", {
            tokenAddress,
            spender: WrapContract,
            amount: maxApproval.toString(),
            chainId,
          });
          approveToken({
            address: tokenAddress,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [WrapContract as `0x${string}`, maxApproval],
            chainId: chainId,
          });
        } else {
          // Already approved, call wrap directly
          console.log("Calling wrap directly:", {
            address: WrapContract,
            amount: amountBigInt.toString(),
            chainId,
          });
          wrapOrUnwrapToken({
            address: WrapContract as `0x${string}`,
            abi: WRAP_CONTRACT_ABI,
            functionName: "wrap",
            args: [amountBigInt],
            chainId: chainId,
          });
        }
      } else {
        // Unwrap mode: no approval needed, directly call unwrap
        wrapOrUnwrapToken({
          address: WrapContract as `0x${string}`,
          abi: WRAP_CONTRACT_ABI,
          functionName: "unwrap",
          args: [amountBigInt],
          chainId: chainId,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Check for RPC errors
      const isRpcError = 
        errorMessage.toLowerCase().includes('rpc endpoint') ||
        errorMessage.toLowerCase().includes('http client error') ||
        errorMessage.toLowerCase().includes('network error') ||
        errorMessage.toLowerCase().includes('fetch failed') ||
        errorMessage.toLowerCase().includes('timeout') ||
        errorMessage.toLowerCase().includes('connection');
      
      const displayError = isRpcError
        ? `RPC connection error. Please check your network connection and try again. If the problem persists, the RPC endpoint may be temporarily unavailable.`
        : errorMessage || "Transaction failed";
      
      setSwapState((prev) => ({
        ...prev,
        status: "error",
        isLoading: false,
        error: displayError,
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
                <h1 className="text-xl font-bold text-foreground">
                  {isWrapMode ? "Wrap" : "Unwrap"}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {isWrapMode ? "Wrap tokens instantly" : "Unwrap tokens instantly"}
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
                  <div className="w-9 h-9 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center text-white font-semibold text-sm">
                    {swapState.fromToken.symbol.charAt(0)}
                  </div>
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
            <motion.button
              className="w-12 h-12 bg-gradient-to-r from-blue-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg hover:from-blue-600 hover:to-purple-700 transition-colors"
              whileTap={{ scale: 0.9 }}
              whileHover={{ scale: 1.05 }}
              transition={{ type: "spring", stiffness: 300, damping: 25 }}
              onClick={() => setIsWrapMode(!isWrapMode)}
              title={isWrapMode ? "Switch to Unwrap" : "Switch to Wrap"}
            >
              <ArrowLeftRight className="w-5 h-5 text-white" />
            </motion.button>
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
                  <div className="w-9 h-9 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center text-white font-semibold text-sm">
                    {swapState.toToken.symbol.charAt(0)}
                  </div>
                  <div className="flex flex-col leading-tight items-start justify-start">
                    <span className="font-semibold">
                      {swapState.toToken.symbol}
                    </span>
                    <span className="text-xs text-muted-foreground flex items-center gap-2">
                      <span className="truncate max-w-[8rem] sm:max-w-[10rem]">
                        {swapState.toNetwork.name}
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
                  {isWrapMode ? "Wrap" : "Unwrap"} Successful!
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
