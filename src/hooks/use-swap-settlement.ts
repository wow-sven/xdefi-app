// TransferHook is not used here; dex hook is provided via constants

import { DEX_HOOK_BY_NETWORK } from "@/constants/dex";
import { NATIVE_TOKEN_ADDRESS, SUPPORTED_PAYMENT_TOKENS } from "@/constants/networks";
import { encodeSwapConfig } from "@/lib/encode-swap-config";
import { okxBuildSwapTx, okxGetApproveTx } from "@/lib/okx";
import {
  type SettleResult,
  prepareSettlement,
  settle as settleWithFacilitator,
  signAuthorization,
} from "@x402x/client";
import { getNetworkConfig } from "@x402x/core";
import { useCallback, useMemo, useState } from "react";
import { parseUnits } from "viem";
import { useChainId, useSwitchChain, useWalletClient } from "wagmi";

export type ExecuteSwapParams = {
  // Chain and network info
  chainId: number;
  // x402x network identifier (e.g., 'base')
  network: string;

  // Swap specifics
  fromTokenAddress?: string; // optional; defaults to the network's USDC (configured in app)
  fromTokenDecimals?: number; // defaults to 6 for USDC when address is omitted
  toTokenAddress: string; // token you receive (OKX native address allowed)
  amount: string; // human units (e.g., '1.23') for fromToken
  slippagePercent: number; // e.g., 0.5

  // Recipient (user) info
  userAddress: string; // EOA initiating the swap; also used as recipient unless payTo is set
  // Optional: pay to a different address than the user (defaults to userAddress)
  payTo?: string;
};

export type UseSwapSettlementResult = {
  execute: (params: ExecuteSwapParams) => Promise<SettleResult | null>;
  status: "idle" | "building" | "preparing" | "signing" | "submitting" | "success" | "error";
  lastError: Error | null;
  lastResult: SettleResult | null;
};

// Construct a safe minAmountOut using either the OKX response or a slippage haircut
// minAmountOut is currently hardcoded to '0' per product requirement

export function useSwapSettlement(): UseSwapSettlementResult {
  const { data: wallet } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const currentChainId = useChainId();
  const [status, setStatus] = useState<UseSwapSettlementResult["status"]>("idle");
  const [lastError, setLastError] = useState<Error | null>(null);
  const [lastResult, setLastResult] = useState<SettleResult | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: <>
  const execute = useCallback<UseSwapSettlementResult["execute"]>(
    async (params) => {
      setLastError(null);
      setLastResult(null);

      if (!wallet) {
        setStatus("error");
        const err = new Error("wallet_unavailable");
        setLastError(err);
        console.error("swap_error: wallet_unavailable", err);
        return null;
      }

      // Network is required by API
      const network = params.network;
      if (!network) {
        setStatus("error");
        const err = new Error("unsupported_network");
        setLastError(err);
        console.error("swap_error: unsupported_network");
        return null;
      }

      // Ensure wallet is on the selected chain for a consistent UX (signature prompt)
      try {
        if (currentChainId && currentChainId !== params.chainId) {
          await switchChainAsync({ chainId: params.chainId });
        }
      } catch (e) {
        setStatus("error");
        const err = new Error("chain_switch_failed");
        setLastError(err);
        console.error("swap_error: chain_switch_failed", e);
        return null;
      }

      // Prepare from-amount in atomic units
      let amountRaw = "0";
      try {
        const decimals = params.fromTokenDecimals ?? (params.fromTokenAddress ? 18 : 6);
        amountRaw = parseUnits(params.amount, decimals).toString();
      } catch (e) {
        setStatus("error");
        const err = new Error("invalid_amount");
        setLastError(err);
        console.error("swap_error: invalid_amount", e);
        return null;
      }

      // Resolve from-token address (default to USDC configured in app)
      const defaultUsdc = SUPPORTED_PAYMENT_TOKENS[network]?.[0];
      const effectiveFromTokenAddress =
        params.fromTokenAddress ||
        (defaultUsdc?.address as string | undefined) ||
        getNetworkConfig(network).defaultAsset.address;

      // 1) Build swap calldata via OKX
      setStatus("building");
      const built = await okxBuildSwapTx({
        chainId: params.chainId,
        fromToken: effectiveFromTokenAddress,
        toToken: params.toTokenAddress,
        amountRaw,
        slippagePercent: params.slippagePercent,
        userAddress: params.userAddress,
      });
      if (!built) {
        setStatus("error");
        const err = new Error("swap_build_failed");
        setLastError(err);
        console.error("swap_error: swap_build_failed");
        return null;
      }

      // 1.5) Get approve transaction to determine approveAddress
      // approveAmount should be the same as amountRaw (the amount being swapped)
      const approveTx = await okxGetApproveTx({
        chainId: params.chainId,
        tokenAddress: effectiveFromTokenAddress,
        approveAmount: amountRaw, // Use the same amount as the swap
      });
      if (!approveTx) {
        setStatus("error");
        const err = new Error("approve_tx_failed");
        setLastError(err);
        console.error("swap_error: approve_tx_failed");
        return null;
      }

      // 2) Encode SwapConfig for the Dex Hook (router from constants; ignore minOut for now)
      const isNative =
        params.toTokenAddress?.toLowerCase?.() === NATIVE_TOKEN_ADDRESS.toLowerCase();
      const toTokenForHook = isNative
        ? ("0x0000000000000000000000000000000000000000" as const)
        : (params.toTokenAddress as `0x${string}`);
      const minAmountOut = "0"; // always 0 (ignore OKX minOut for now)
      const hookDataForDex = encodeSwapConfig({
        // Use the aggregator/route address returned by OKX in tx.to
        dexAggregator: built.aggregatorAddress as `0x${string}`,
        // Get approveAddress from OKX approve-transaction API
        approveAddress: approveTx.approveAddress as `0x${string}`,
        swapCalldata: built.data,
        toToken: toTokenForHook,
        minAmountOut,
        isNativeToken: isNative,
      });
      // console.log(hookDataForDex)

      // 3) Prepare, sign and settle
      setStatus("preparing");
      const hookAddress = DEX_HOOK_BY_NETWORK[network];
      if (!hookAddress) {
        setStatus("error");
        const err = new Error(`dex_hook_missing_for_${network}`);
        setLastError(err);
        console.error("swap_error: dex_hook_missing", network);
        return null;
      }
      const hookData = hookDataForDex;

      try {
        const settlement = await prepareSettlement({
          wallet,
          network,
          hook: hookAddress,
          hookData,
          amount: amountRaw,
          payTo: (params.payTo || params.userAddress) as `0x${string}`,
          facilitatorFee: "15000",
          //   facilitatorUrl: "https://facilitator.x402x.dev",
          // facilitatorFee: omitted -> queried by client
        });
        console.log("Settlement Request", settlement);

        setStatus("signing");
        const signed = await signAuthorization(wallet, settlement);

        setStatus("submitting");
        const result = await settleWithFacilitator("https://facilitator.x402x.dev", signed);
        setLastResult(result);
        setStatus(result.success ? "success" : "error");
        return result;
      } catch (e) {
        setStatus("error");
        const err = new Error((e as Error).message || "swap_failed");
        setLastError(err);
        console.error("swap_error: execution", e);
        return null;
      }
    },
    [wallet, currentChainId],
  );

  return useMemo(
    () => ({ execute, status, lastError, lastResult }),
    [execute, status, lastError, lastResult],
  );
}
