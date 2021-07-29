import { ApolloClient, HttpLink, gql, InMemoryCache } from '@apollo/client';
import { BigNumber } from '@ethersproject/bignumber'
import { ethers } from 'ethers';
import fetch from 'cross-fetch';
import React from 'react';
import uniswapPoolABI from './uniswapPoolABI'
import guniPoolABI from './guniPoolABI'
import * as dotenv from "dotenv";
dotenv.config({ path: __dirname + "/.env" });

const X96 = BigNumber.from(2).pow(BigNumber.from(96))
const BLOCKS_PER_YEAR = 2102400

const computeAverageReserves = (snapshots: any, sqrtPriceX96: BigNumber, firstBlock: number) => {
  let cumulativeBlocks = BigNumber.from(0)
  let cumulativeReserves = BigNumber.from(0)
  const priceX96X96 = sqrtPriceX96.mul(sqrtPriceX96)
  for (let i=0; i<snapshots.length; i++) {
    if (Number(snapshots[i].block) > firstBlock) {
      const reserves0 = BigNumber.from(snapshots[i].reserves0)
      const reserves1 = BigNumber.from(snapshots[i].reserves1)
      const reserves0As1X96 = reserves0.mul(priceX96X96).div(X96)
      const reserves0As1 = reserves0As1X96.div(X96)
      const reserves = reserves1.add(reserves0As1)
      let blockDifferential: BigNumber
      if (i==0) {
        blockDifferential = BigNumber.from(snapshots[i].block).sub(BigNumber.from(firstBlock.toString()))
      } else {
        blockDifferential = BigNumber.from(snapshots[i].block).sub(BigNumber.from(snapshots[i-1].block))
      }
      if (blockDifferential.lt(ethers.constants.Zero)) {
        blockDifferential = ethers.constants.Zero
      }
      cumulativeReserves = cumulativeReserves.add(reserves.mul(blockDifferential))
      cumulativeBlocks = cumulativeBlocks.add(blockDifferential)
    }
  }
  return cumulativeReserves.div(cumulativeBlocks)
}

const computeTotalFeesEarned = (snapshots: any, sqrtPriceX96: BigNumber): BigNumber => {
  let feesEarned0 = BigNumber.from(0)
  let feesEarned1 = BigNumber.from(0)
  for (let i=0; i<snapshots.length; i++) {
    feesEarned0 = feesEarned0.add(BigNumber.from(snapshots[i].feesEarned0))
    feesEarned1 = feesEarned1.add(BigNumber.from(snapshots[i].feesEarned1))
  }
  const priceX96X96 = sqrtPriceX96.mul(sqrtPriceX96)
  const fees0As1X96 = feesEarned0.mul(priceX96X96).div(X96)
  const fees0As1 = fees0As1X96.div(X96)
  return feesEarned1.add(fees0As1)
}

const getAPR = async (poolData: any, guniPoolContract: any, uniswapPoolContract: any, helpersContract: any, balance0: BigNumber, balance1: BigNumber): Promise<number> => {
  if (poolData.supplySnapshots.length == 0) {
    return 0
  }
  if (poolData.feeSnapshots.length == 0) {
    return 0
  }
  let snapshots = [...poolData.feeSnapshots].sort((a: any, b:any) => (a.block > b.block) ? 1: -1)
  let supplySnaps = [...poolData.supplySnapshots].sort((a: any, b: any) => (a.block > b.block) ? 1: -1)
  let currentBlock = (await helpersContract.provider.getBlock('latest')).number
  const sqrtPriceX96 = (await uniswapPoolContract.slot0()).sqrtPriceX96
  const {amount0Current, amount1Current} = await guniPoolContract.getUnderlyingBalances()
  const positionId = await guniPoolContract.getPositionID()
  const {_liquidity} = await uniswapPoolContract.positions(positionId)
  const {amount0, amount1} = await helpersContract.getAmountsForLiquidity(sqrtPriceX96, poolData.lowerTick, poolData.upperTick, _liquidity)
  let feesEarned0 = amount0Current.sub(amount0).sub(balance0)
  let feesEarned1 = amount1Current.sub(amount1).sub(balance1)
  if (feesEarned0.lt(ethers.constants.Zero)) {
    feesEarned0 = ethers.constants.Zero
  }
  if (feesEarned1.lt(ethers.constants.Zero)) {
    feesEarned1 = ethers.constants.Zero
  }
  snapshots.push({
    block: currentBlock.toString(),
    feesEarned0: feesEarned0.toString(),
    feesEarned1: feesEarned1.toString()
  })
  const totalFeeValue = computeTotalFeesEarned(snapshots, sqrtPriceX96)
  const averageReserves = computeAverageReserves(supplySnaps, sqrtPriceX96, Number(poolData.lastTouchWithoutFees))
  let averagePrincipal = averageReserves.sub(totalFeeValue)
  if (averagePrincipal.lt(ethers.constants.Zero)) {
    averagePrincipal = averageReserves
  }
  const totalBlocks = Number(currentBlock.toString()) - Number(poolData.lastTouchWithoutFees)
  const apr = (Number(ethers.utils.formatEther(totalFeeValue)) * BLOCKS_PER_YEAR) / (Number(ethers.utils.formatEther(averagePrincipal)) * totalBlocks)
  return apr
} 

export const fetchAPRs = async () => {
    const APIURL = "https://api.thegraph.com/subgraphs/name/gelatodigital/g-uni";
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
          lastTouchWithoutFees
          supplySnapshots {
            id
            block
            reserves0
            reserves1
          }
          feeSnapshots {
            id
            block
            feesEarned0
            feesEarned1
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
    const helpersContract = new ethers.Contract(UNISWAP_HELPERS_ADDRESS, ["function getAmountsForLiquidity(uint160,int24,int24,uint128) external pure returns(uint256 amount0,uint256 amount1)"], PROVIDER)
    for (let i=0; i<pools.length; i++) {
      const guniPoolContract = new ethers.Contract(ethers.utils.getAddress(pools[i].id), guniPoolABI, PROVIDER)
      const uniswapPoolContract = new ethers.Contract(ethers.utils.getAddress(pools[i].uniswapPool), uniswapPoolABI, PROVIDER)
      const token0 = new ethers.Contract(ethers.utils.getAddress(pools[i].token0), ["function balanceOf(address) external view returns (uint256)"], PROVIDER)
      const token1 = new ethers.Contract(ethers.utils.getAddress(pools[i].token1), ["function balanceOf(address) external view returns (uint256)"], PROVIDER)
      const balance0 = await token0.balanceOf(ethers.utils.getAddress(pools[i].id))
      const balance1 = await token1.balanceOf(ethers.utils.getAddress(pools[i].id))
      console.log(`fetching apr for pool ${pools[i].id.substring(0, 6)}...`)
      const apr = await getAPR(pools[i], guniPoolContract, uniswapPoolContract, helpersContract, balance0, balance1)
      
      console.log(`pool ${pools[i].id.substring(0, 6)}: ${(100*apr).toFixed(3)}%`)
    }
}

(async () => {
    await fetchAPRs()
})();