import type { ApiPromise } from "@polkadot/api";
import type { Extrinsic, BlockHash, EventRecord } from "@polkadot/types/interfaces";
import type { Block } from "@polkadot/types/interfaces/runtime/types";
import type { Option } from "@polkadot/types";
import { u8aConcat, u8aToString } from "@polkadot/util";
import { xxhashAsU8a } from "@polkadot/util-crypto";
import { ethereumEncode } from "@polkadot/util-crypto";
import { mapExtrinsics, TxWithEventAndFee } from "./types";

import "@polkadot/api-augment";

import chalk from "chalk";
import Debug from "debug";
import { PalletIdentityRegistration } from "@polkadot/types/lookup";
const debug = Debug("monitoring");

export interface BlockDetails {
  block: Block;
  authorName: string;
  blockTime: number;
  records: EventRecord[];
  txWithEvents: TxWithEventAndFee[];
  weightPercentage: number;
}

// TODO: Improve with cache and eviction
const authorMappingCache: {
  [author: string]: {
    account?: string;
    lastUpdate: number;
  };
} = {};

const identityCache: {
  [author: string]: {
    identity?: PalletIdentityRegistration;
    lastUpdate: number;
  };
} = {};

const getIdentityKey = (account: string) => {
  return `0x${Buffer.from(
    u8aConcat(
      xxhashAsU8a("Identity", 128),
      xxhashAsU8a("IdentityOf", 128),
      xxhashAsU8a(account, 64),
      account
    )
  ).toString("hex")}`;
};

export const getAccountIdentities = async (
  api: ApiPromise,
  accounts: string[],
  at?: BlockHash | string
): Promise<string[]> => {
  if (!accounts || accounts.length == 0) {
    return [];
  }
  const missingAccounts = accounts.filter(
    (account) =>
      account &&
      (!identityCache[account] || identityCache[account].lastUpdate < Date.now() - 3600 * 1000)
  );

  if (missingAccounts.length > 0) {
    const keys = missingAccounts.map((a) => getIdentityKey(a.toString()));
    const identities = await api.rpc.state.queryStorageAt<Option<PalletIdentityRegistration>[]>(
      keys,
      at
    );
    identities.forEach((identityData, i) => {
      identityCache[missingAccounts[i]] = {
        lastUpdate: Date.now(),
        identity:
          identityData.isSome &&
          api.registry.createType("PalletIdentityRegistration", identityData.toString()),
      };
    });
  }

  return accounts.map((account) =>
    account && identityCache[account].identity
      ? u8aToString(identityCache[account].identity.info.display.asRaw.toU8a(true))
      : account?.toString()
  );
};

export const getAccountIdentity = async (api: ApiPromise, account: string): Promise<string> => {
  if (!account) {
    return "";
  }
  if (!identityCache[account] || identityCache[account].lastUpdate < Date.now() - 3600 * 1000) {
    const identityData = await api.query.identity.identityOf(account.toString());
    identityCache[account] = {
      lastUpdate: Date.now(),
      identity: identityData.unwrapOr(undefined),
    };
  }

  const { identity } = identityCache[account];
  return identity ? u8aToString(identity.info.display.asRaw.toU8a(true)) : account?.toString();
};

export const getAuthorIdentity = async (api: ApiPromise, author: string): Promise<string> => {
  if (
    !authorMappingCache[author] ||
    authorMappingCache[author].lastUpdate < Date.now() - 3600 * 1000
  ) {
    const mappingData = (await api.query.authorMapping.mappingWithDeposit(author)) as Option<any>;
    authorMappingCache[author] = {
      lastUpdate: Date.now(),
      account: mappingData.isEmpty ? null : ethereumEncode(mappingData.unwrap().account.toString()),
    };
  }
  const { account } = authorMappingCache[author];

  return getAccountIdentity(api, account);
};

export const getBlockDetails = async (api: ApiPromise, blockHash: BlockHash) => {
  debug(`Querying ${blockHash}`);
  const maxBlockWeight = api.consts.system.blockWeights.maxBlock.toBigInt();
  const apiAt = await api.at(blockHash);
  const [{ block }, records, blockTime] = await Promise.all([
    api.rpc.chain.getBlock(blockHash),
    apiAt.query.system.events(),
    apiAt.query.timestamp.now(),
  ]);

  const authorId =
    block.extrinsics
      .find((tx) => tx.method.section == "authorInherent" && tx.method.method == "setAuthor")
      ?.args[0]?.toString() ||
    block.header.digest.logs
      .find(
        (l) => l.isPreRuntime && l.asPreRuntime.length > 0 && l.asPreRuntime[0].toString() == "nmbs"
      )
      ?.asPreRuntime[1]?.toString();

  const [fees, authorName] = await Promise.all([
    Promise.all(
      block.extrinsics.map((ext) => api.rpc.payment.queryInfo(ext.toHex(), block.header.parentHash))
    ),
    authorId
      ? getAuthorIdentity(api, authorId)
      : "0x0000000000000000000000000000000000000000000000000000000000000000",
  ]);

  const txWithEvents = mapExtrinsics(block.extrinsics, records, fees);
  const blockWeight = txWithEvents.reduce((totalWeight, tx, index) => {
    return totalWeight + (tx.dispatchInfo && tx.dispatchInfo.weight.toBigInt());
  }, 0n);
  return {
    block,
    authorName,
    blockTime: blockTime.toNumber(),
    weightPercentage: Number((blockWeight * 10000n) / maxBlockWeight) / 100,
    txWithEvents,
    records,
  } as BlockDetails;
};

export interface BlockRangeOption {
  from: number;
  to: number;
  concurrency?: number;
}

// Explore all blocks for the given range adn return block information for each one
// fromBlockNumber and toBlockNumber included
export const exploreBlockRange = async (
  api: ApiPromise,
  { from, to, concurrency = 1 }: BlockRangeOption,
  callBack: (blockDetails: BlockDetails) => Promise<void>
) => {
  let current = from;
  while (current <= to) {
    const concurrentTasks = [];
    for (let i = 0; i < concurrency && current <= to; i++) {
      concurrentTasks.push(
        api.rpc.chain.getBlockHash(current++).then((hash) => getBlockDetails(api, hash))
      );
    }
    const blocksDetails = await Promise.all(concurrentTasks);
    for (const blockDetails of blocksDetails) {
      await callBack(blockDetails);
    }
  }
};

export interface RealtimeBlockDetails extends BlockDetails {
  elapsedMilliSecs: number;
  pendingTxs: Extrinsic[];
}

export const listenBlocks = async (
  api: ApiPromise,
  finalized: boolean,
  callBack: (blockDetails: RealtimeBlockDetails) => Promise<void>
) => {
  let latestBlockTime = 0;
  try {
    latestBlockTime = (
      await api.query.timestamp.now.at((await api.rpc.chain.getBlock()).block.header.parentHash)
    ).toNumber();
  } catch (e) {
    // This can happen if you start at genesis block
    latestBlockTime = 0;
  }
  const call = finalized ? api.rpc.chain.subscribeFinalizedHeads : api.rpc.chain.subscribeNewHeads;
  const unsubHeads = await call(async (lastHeader) => {
    const [blockDetails, pendingTxs] = await Promise.all([
      getBlockDetails(api, lastHeader.hash),
      api.rpc.author.pendingExtrinsics(),
    ]);
    callBack({
      ...blockDetails,
      pendingTxs,
      elapsedMilliSecs: blockDetails.blockTime - latestBlockTime,
    });
    latestBlockTime = blockDetails.blockTime;
  });
  return unsubHeads;
};

export const listenBestBlocks = async (
  api: ApiPromise,
  callBack: (blockDetails: RealtimeBlockDetails) => Promise<void>
) => {
  listenBlocks(api, false, callBack);
};

export const listenFinalizedBlocks = async (
  api: ApiPromise,
  callBack: (blockDetails: RealtimeBlockDetails) => Promise<void>
) => {
  listenBlocks(api, true, callBack);
};

export function generateBlockDetailsLog(
  blockDetails: BlockDetails | RealtimeBlockDetails,
  options?: { prefix?: string; suffix?: string },
  previousBlockDetails?: BlockDetails | RealtimeBlockDetails
) {
  let secondText = null;
  if (previousBlockDetails) {
    const elapsedMilliSecs = blockDetails.blockTime - previousBlockDetails.blockTime;
    const seconds = (Math.floor(elapsedMilliSecs / 100) / 10).toFixed(1).padStart(5, " ");
    secondText =
      elapsedMilliSecs > 30000
        ? chalk.red(seconds)
        : elapsedMilliSecs > 14000
        ? chalk.yellow(seconds)
        : seconds;
  }

  const weight = blockDetails.weightPercentage.toFixed(2).padStart(5, " ");
  const weightText =
    blockDetails.weightPercentage > 60
      ? chalk.red(weight)
      : blockDetails.weightPercentage > 30
      ? chalk.yellow(weight)
      : blockDetails.weightPercentage > 10
      ? chalk.green(weight)
      : weight;

  let txPoolText = null;
  let poolIncText = null;
  if ("pendingTxs" in blockDetails) {
    const txPool = blockDetails.pendingTxs.length.toString().padStart(4, " ");
    txPoolText =
      blockDetails.pendingTxs.length > 1000
        ? chalk.red(txPool)
        : blockDetails.pendingTxs.length > 100
        ? chalk.yellow(txPool)
        : txPool;

    if (previousBlockDetails && "pendingTxs" in previousBlockDetails) {
      const newPendingHashes = previousBlockDetails.pendingTxs.map((tx) => tx.hash.toString());
      const txPoolDiff = blockDetails.pendingTxs
        .map((tx) => tx.hash.toString())
        .filter((x) => !newPendingHashes.includes(x)).length;
      const poolInc = txPoolDiff.toString().padStart(3, " ");
      poolIncText =
        txPoolDiff > 80 ? chalk.red(poolInc) : txPoolDiff > 30 ? chalk.yellow(poolInc) : poolInc;
    }
  }

  const ext = blockDetails.block.extrinsics.length.toString().padStart(3, " ");
  const extText =
    blockDetails.block.extrinsics.length >= 100
      ? chalk.red(ext)
      : blockDetails.block.extrinsics.length >= 50
      ? chalk.yellow(ext)
      : blockDetails.block.extrinsics.length > 15
      ? chalk.green(ext)
      : ext;

  const ethTxs = blockDetails.block.extrinsics.filter(
    (tx) => tx.method.section == "ethereum" && tx.method.method == "transact"
  ).length;
  const eths = ethTxs.toString().padStart(3, " ");
  const evmText =
    ethTxs >= 97
      ? chalk.red(eths)
      : ethTxs >= 47
      ? chalk.yellow(eths)
      : ethTxs > 12
      ? chalk.green(eths)
      : eths;

  const fees = blockDetails.txWithEvents
    .filter(({ dispatchInfo }) => dispatchInfo.paysFee.isYes && !dispatchInfo.class.isMandatory)
    .reduce((p, { dispatchInfo, extrinsic, events, fee }) => {
      if (extrinsic.method.section == "ethereum") {
        const payload = extrinsic.method.args[0] as any;
        const gasPrice =
          payload.asLegacy?.gasPrice ||
          payload.asEip2930?.gasPrice ||
          payload.asEip1559?.gasPrice ||
          payload.gasPrice;
        return p + (BigInt(gasPrice) * dispatchInfo.weight.toBigInt()) / 25000n;
      }
      return p + fee.partialFee.toBigInt();
    }, 0n);
  const feesTokens = Number(fees / 10n ** 15n) / 1000;
  const feesTokenTxt = feesTokens.toFixed(3).padStart(5, " ");
  const feesText =
    feesTokens >= 0.1
      ? chalk.red(feesTokenTxt)
      : feesTokens >= 0.01
      ? chalk.yellow(feesTokenTxt)
      : feesTokens >= 0.001
      ? chalk.green(feesTokenTxt)
      : feesTokenTxt;

  const transferred = blockDetails.txWithEvents
    .map((tx) => {
      if (tx.extrinsic.method.section == "ethereum" && tx.extrinsic.method.method == "transact") {
        const payload = tx.extrinsic.method.args[0] as any;
        return (
          payload.asLegacy?.value.toBigInt() ||
          payload.asEip2930?.value.toBigInt() ||
          payload.asEip1559?.value.toBigInt() ||
          payload.value.toBigInt()
        );
      }
      return tx.events.reduce((total, event) => {
        if (event.section == "balances" && event.method == "Transfer") {
          return total + (event.data[2] as any).toBigInt();
        }
        return total;
      }, 0n);
    })
    .reduce((p, v) => p + v, 0n);
  const transferredTokens = Number(transferred / 10n ** 18n);
  const transferredText = transferredTokens.toString().padStart(5, " ");
  const coloredTransferred =
    transferredTokens >= 100
      ? chalk.red(transferredText)
      : transferredTokens >= 50
      ? chalk.yellow(transferredText)
      : transferredTokens > 15
      ? chalk.green(transferredText)
      : transferredText;

  const authorId =
    blockDetails.authorName.length > 20
      ? `${blockDetails.authorName.substring(0, 7)}..${blockDetails.authorName.substring(
          blockDetails.authorName.length - 4
        )}`
      : blockDetails.authorName;

  const hash = blockDetails.block.header.hash.toString();
  const time = new Date().toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return `${time} ${options?.prefix ? `${options.prefix} ` : ""}#${blockDetails.block.header.number
    .toString()
    .padEnd(
      7,
      " "
    )} [${weightText}%, ${feesText} fees, ${extText} Txs (${evmText} Eth)(<->${coloredTransferred})]${
    txPoolText ? `[Pool:${txPoolText}${poolIncText ? `(+${poolIncText})` : ""}]` : ``
  }${secondText ? `[${secondText}s]` : ""}(hash: ${hash.substring(0, 7)}..${hash.substring(
    hash.length - 4
  )})${options?.suffix ? ` ${options.suffix}` : ""} by ${authorId}`;
}

export function printBlockDetails(
  blockDetails: BlockDetails | RealtimeBlockDetails,
  options?: { prefix?: string; suffix?: string },
  previousBlockDetails?: BlockDetails | RealtimeBlockDetails
) {
  console.log(generateBlockDetailsLog(blockDetails, options, previousBlockDetails));
}
