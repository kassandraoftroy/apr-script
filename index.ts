import { ApolloClient, HttpLink, gql, InMemoryCache } from '@apollo/client';
import { BigNumber } from '@ethersproject/bignumber'
import { ethers } from 'ethers';
import fetch from 'cross-fetch';
import React from 'react';
import uniswapPoolABI from './uniswapPoolABI'
import guniPoolABI from './guniPoolABI'
import * as dotenv from "dotenv";
dotenv.config({ path: __dirname + "/.env" });

const computeAPRFromSnapshots = (snapshots: any) => {
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

const getAPR = async (poolData: any, helpersContract: any, guniPoolContract: any, uniswapPoolContract: any): Promise<number> => {
  if (poolData.supplySnapshots.length == 0) {
    return 0
  }
  let snapshots = [...poolData.rebalanceSnapshots].sort((a: any, b:any) => (a.block > b.block) ? 1: -1)
  let supplySnaps = [...poolData.supplySnapshots].sort((a: any, b: any) => (a.block < b.block) ? 1: -1)
  let currentBlock = (await helpersContract.provider.getBlock('latest')).number
  if (snapshots.length == 0) {
    for (let j=0; j<supplySnaps.length; j++) {
      if (Number(supplySnaps[j].block) + 5600 < Number(currentBlock.toString())) {
        snapshots.push(supplySnaps[j])
        break
      }
    }
  }
  if (snapshots.length == 0) {
    return 0
  }
  const sqrtPriceX96 = (await uniswapPoolContract.slot0()).sqrtPriceX96
  const gross = await guniPoolContract.getUnderlyingBalances()
  const liquidity = await helpersContract.getLiquidityForAmounts(sqrtPriceX96, poolData.lowerTick, poolData.upperTick, gross[0], gross[1])
  const tickSpan = Number(poolData.upperTick) - Number(poolData.lowerTick)
  snapshots.push({
    block: currentBlock.toString(),
    totalSupply: poolData.totalSupply,
    liquidity: liquidity.toString(),
    tickSpan: tickSpan.toString()
  })
  return computeAPRFromSnapshots(snapshots)
} 

export const fetchAPRs = async () => {
    const APIURL = "https://api.thegraph.com/subgraphs/name/superarius/guni";
    const PROVIDER = new ethers.providers.JsonRpcProvider(`https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_ID}`)
    const UNISWAP_HELPERS_ADDRESS = '0xFbd0B8D8016b9f908fC9652895c26C5a4994fE36'

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
    
    const helpersContract = new ethers.Contract(UNISWAP_HELPERS_ADDRESS, ["function getLiquidityForAmounts(uint160,int24,int24,uint256,uint256) external pure returns(uint128)"], PROVIDER)
    console.log("fetching pools...")
    for (let i=0; i<pools.length; i++) {
      const guniPoolContract = new ethers.Contract(ethers.utils.getAddress(pools[i].id), guniPoolABI, PROVIDER)
      const uniswapPoolContract = new ethers.Contract(ethers.utils.getAddress(pools[i].uniswapPool), uniswapPoolABI, PROVIDER)

      const apr = await getAPR(pools[i], helpersContract, guniPoolContract, uniswapPoolContract)
      
      console.log(`pool ${pools[i].id.substring(0, 6)}: ${(100*apr).toFixed(3)}%`)
    }
}

(async () => {
    await fetchAPRs()
})();