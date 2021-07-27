import { ApolloClient, HttpLink, gql, InMemoryCache } from '@apollo/client';
import { BigNumber } from '@ethersproject/bignumber'
import { ethers } from 'ethers';
import fetch from 'cross-fetch';
import React from 'react';
import uniswapPoolABI from './uniswapPoolABI'
import guniPoolABI from './guniPoolABI'
import * as dotenv from "dotenv";
dotenv.config({ path: __dirname + "/.env" });

const ALCHEMY_ID = process.env.ALCHEMY_ID;
const UNISWAP_HELPERS_ADDRESS = '0xFbd0B8D8016b9f908fC9652895c26C5a4994fE36'

const getAPRFromSnapshots = (snapshots: any) => {
  let cumulativeBlocks = 0
  let cumulativeGrowth = 0
  for (let i=1; i<snapshots.length; i++) {
    const lastSnapshot = snapshots[i-1]
    const currentSnapshot = snapshots[i]
    const blockDelta = Number(currentSnapshot.block) - Number(lastSnapshot.block)
    cumulativeBlocks += blockDelta
    const lastNumerator = Number(ethers.utils.formatEther(BigNumber.from(lastSnapshot.tickSpan).mul(BigNumber.from(lastSnapshot.liquidity))))
    const lastValue = lastNumerator/Number(ethers.utils.formatEther(lastSnapshot.totalSupply))
    const currentNumerator = Number(ethers.utils.formatEther(BigNumber.from(currentSnapshot.tickSpan).mul(BigNumber.from(currentSnapshot.liquidity))))
    const currentValue = currentNumerator/Number(ethers.utils.formatEther(currentSnapshot.totalSupply))
    const valueDelta = (currentValue-lastValue)/lastValue
    cumulativeGrowth += valueDelta * blockDelta
  }
  let avgGrowth = cumulativeGrowth/cumulativeBlocks
  let growthPerYear = avgGrowth*2102400/cumulativeBlocks
  return growthPerYear
}

const getAPRs = async (pools: any) => {
  const PROVIDER = new ethers.providers.JsonRpcProvider(`https://eth-mainnet.alchemyapi.io/v2/${ALCHEMY_ID}`)
  const liquidityContract = new ethers.Contract(UNISWAP_HELPERS_ADDRESS, ["function getLiquidityForAmounts(uint160,int24,int24,uint256,uint256) external pure returns(uint128)"], PROVIDER)
  let aprs = []
  for (let i=0; i<pools.length; i++) {
    if (pools[i].supplySnapshots.length == 0) {
      continue
    }
    let snapshots = [...pools[i].rebalanceSnapshots].sort((a: any, b:any) => (a.block > b.block) ? 1: -1)
    let supplySnaps = [...pools[i].supplySnapshots].sort((a: any, b: any) => (a.block < b.block) ? 1: -1)
    let currentBlock = (await PROVIDER.getBlock('latest')).number
    if (snapshots.length == 0) {
      let found = false
      for (let j=0; j<supplySnaps.length; j++) {
        if ((Number(supplySnaps[j].block) + 5600 < Number(currentBlock.toString())) && !found) {
          snapshots.push(supplySnaps[j])
          found = true
        }
      }
    }
    const guniPool = new ethers.Contract(ethers.utils.getAddress(pools[i].id), guniPoolABI, PROVIDER)
    const uniswapPool = new ethers.Contract(ethers.utils.getAddress(pools[i].uniswapPool), uniswapPoolABI, PROVIDER)
    const sqrtPriceX96 = (await uniswapPool.slot0()).sqrtPriceX96
    const gross = await guniPool.getUnderlyingBalances()
    const liquidity = await liquidityContract.getLiquidityForAmounts(sqrtPriceX96, pools[i].lowerTick, pools[i].upperTick, gross[0], gross[1])
    const tickSpan = Number(pools[i].upperTick) - Number(pools[i].lowerTick)
    snapshots.push({
      block: currentBlock.toString(),
      totalSupply: pools[i].totalSupply,
      liquidity: liquidity,
      tickSpan: tickSpan
    })
    const apr = getAPRFromSnapshots(snapshots)
    console.log(`pool ${pools[i].id.substring(0, 6)}: ${(100*apr).toFixed(3)}%`)
    aprs.push(apr)
  }

  return aprs
}

export const fetchAPRs = async (): Promise<number[]> => {
    const APIURL = "https://api.thegraph.com/subgraphs/name/superarius/guni";
  
    const obsQ = `
      query {
        pools {
          id
          blockCreated
          manager
          address
          uniswapPool
          token0
          token1
          feeTier
          liquidity
          lowerTick
          upperTick
          totalSupply
          supplySnapshots {
            id
            totalSupply
            liquidity
            block
            tickSpan
          }
          rebalanceSnapshots {
            id
            totalSupply
            liquidity
            block
            tickSpan
          }
        }
      }
    `;
    const client = new ApolloClient({
        link: new HttpLink({ uri: APIURL, fetch }),
        cache: new InMemoryCache()
    });
    
    const data = await client.query({
      query: gql(obsQ)
    })
    const pools = data.data.pools
    return getAPRs(pools)
}

(async () => {
    await fetchAPRs()
})();