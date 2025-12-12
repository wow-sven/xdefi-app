import { SwapComponent } from "@/components/bnb-crypto-wrap";
import { PageHeader, PageHeaderHeading } from "@/components/page-header";
import Seo from "@/components/Seo";


export default function BNBWrapPage() {
  return (
    <>
      <PageHeader>
        <PageHeaderHeading className="sr-only">bnb-wrap</PageHeaderHeading>
      </PageHeader>
      {/* Let Seo infer canonical from current route; avoids forcing '/' on /swap */}
      <Seo
        title="bnb-wrap"
        description="Swap tokens across EVM networks with aggregated DEX routing, real-time quotes, slippage control, and transparent fees."
        keywords={["swap", "dex", "exchange", "crypto", "xdefi", "evm", "price routing"]}
      />
      <SwapComponent/>
    </>
  );
}
