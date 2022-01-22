import Common from '@ethereumjs/common'
import { BN, keccak256, setLengthRight, setLengthLeft } from 'ethereumjs-util'
import { ERROR, VmError } from './../../exceptions'
import { RunState } from './../interpreter'
import { adjustSstoreGasEIP2929 } from './EIP2929'

const MASK_160 = new BN(1).shln(160).subn(1)

/**
 * Proxy function for ethereumjs-util's setLengthLeft, except it returns a zero
 *
 * length buffer in case the buffer is full of zeros.
 * @param {Buffer} value Buffer which we want to pad
 */
export function setLengthLeftStorage(value: Buffer) {
  if (value.equals(Buffer.alloc(value.length, 0))) {
    // return the empty buffer (the value is zero)
    return Buffer.alloc(0)
  } else {
    return setLengthLeft(value, 32)
  }
}

/**
 * Wraps error message as VMError
 *
 * @param {string} err
 */
export function trap(err: string) {
  // TODO: facilitate extra data along with errors
  throw new VmError(err as ERROR)
}

/**
 * Converts BN address (they're stored like this on the stack) to buffer address
 *
 * @param  {BN}     address
 * @return {Buffer}
 */
export function addressToBuffer(address: BN | Buffer) {
  if (Buffer.isBuffer(address)) return address
  return address.and(MASK_160).toArrayLike(Buffer, 'be', 20)
}

/**
 * Error message helper - generates location string
 *
 * @param  {RunState} runState
 * @return {string}
 */
export function describeLocation(runState: RunState): string {
  const hash = keccak256(runState.eei.getCode()).toString('hex')
  const address = runState.eei.getAddress().buf.toString('hex')
  const pc = runState.programCounter - 1
  return `${hash}/${address}:${pc}`
}

/**
 * Find Ceil(a / b)
 *
 * @param {bigint} a
 * @param {bigint} b
 * @return {bigint}
 */
export function divCeil(a: bigint, b: bigint): bigint {
  const div = a / b
  const modulus = mod(a, b)

  // Fast case - exact division
  if (modulus === 0n) return div

  // Round up
  return div < 0n ? div - 1n : div + 1n
}

export function short(buffer: Buffer): string {
  const MAX_LENGTH = 50
  const bufferStr = buffer.toString('hex')
  if (bufferStr.length <= MAX_LENGTH) {
    return bufferStr
  }
  return bufferStr.slice(0, MAX_LENGTH) + '...'
}

/**
/**
 * Returns an overflow-safe slice of an array. It right-pads
 * the data with zeros to `length`.
 *
 * @param {BN} offset
 * @param {BN} length
 * @param {Buffer} data
 * @returns {Buffer}
 */
export function getDataSlice(data: Buffer, offset: BN, length: BN): Buffer {
  const len = new BN(data.length)
  if (offset.gt(len)) {
    offset = len
  }

  let end = offset.add(length)
  if (end.gt(len)) {
    end = len
  }

  data = data.slice(offset.toNumber(), end.toNumber())
  // Right-pad with zeros to fill dataLength bytes
  data = setLengthRight(data, length.toNumber())

  return data
}

/**
 * Get full opcode name from its name and code.
 *
 * @param code {number} Integer code of opcode.
 * @param name {string} Short name of the opcode.
 * @returns {string} Full opcode name
 */
export function getFullname(code: number, name: string): string {
  switch (name) {
    case 'LOG':
      name += code - 0xa0
      break
    case 'PUSH':
      name += code - 0x5f
      break
    case 'DUP':
      name += code - 0x7f
      break
    case 'SWAP':
      name += code - 0x8f
      break
  }
  return name
}

/**
 * Checks if a jump is valid given a destination
 *
 * @param  {RunState} runState
 * @param  {number}   dest
 * @return {boolean}
 */
export function jumpIsValid(runState: RunState, dest: number): boolean {
  return runState.validJumps.indexOf(dest) !== -1
}

/**
 * Checks if a jumpsub is valid given a destination
 *
 * @param  {RunState} runState
 * @param  {number}   dest
 * @return {boolean}
 */
export function jumpSubIsValid(runState: RunState, dest: number): boolean {
  return runState.validJumpSubs.indexOf(dest) !== -1
}

/**
 * Returns an overflow-safe slice of an array. It right-pads
 *
 * the data with zeros to `length`.
 * @param {BN} gasLimit - requested gas Limit
 * @param {BN} gasLeft - current gas left
 * @param {RunState} runState - the current runState
 * @param {Common} common - the common
 */
export function maxCallGas(gasLimit: BN, gasLeft: BN, runState: RunState, common: Common): BN {
  const isTangerineWhistleOrLater = common.gteHardfork('tangerineWhistle')
  if (isTangerineWhistleOrLater) {
    const gasAllowed = gasLeft.sub(gasLeft.divn(64))
    return gasLimit.gt(gasAllowed) ? gasAllowed : gasLimit
  } else {
    return gasLimit
  }
}

/**
 * Subtracts the amount needed for memory usage from `runState.gasLeft`
 *
 * @method subMemUsage
 * @param {Object} runState
 * @param {BN} offset
 * @param {BN} length
 */
export function subMemUsage(runState: RunState, offset: bigint, length: bigint, common: Common) {
  // YP (225): access with zero length will not extend the memory
  if (length === 0n) return

  const newMemoryWordCount = divCeil(offset + length, 32n)
  if (newMemoryWordCount >= runState.memoryWordCount) return

  const words = newMemoryWordCount
  const fee = new BN(common.param('gasPrices', 'memory'))
  const quadCoeff = new BN(common.param('gasPrices', 'quadCoeffDiv'))
  // words * 3 + words ^2 / 512
  const cost = words.mul(fee).add(words.mul(words).div(quadCoeff))

  if (cost.gt(runState.highestMemCost)) {
    runState.eei.useGas(cost.sub(runState.highestMemCost), 'subMemUsage')
    runState.highestMemCost = cost
  }

  runState.memoryWordCount = newMemoryWordCount
}

/**
 * Writes data returned by eei.call* methods to memory
 *
 * @param {RunState} runState
 * @param {BN}       outOffset
 * @param {BN}       outLength
 */
export function writeCallOutput(runState: RunState, outOffset: BN, outLength: BN) {
  const returnData = runState.eei.getReturnData()
  if (returnData.length > 0) {
    const memOffset = outOffset.toNumber()
    let dataLength = outLength.toNumber()
    if (returnData.length < dataLength) {
      dataLength = returnData.length
    }
    const data = getDataSlice(returnData, new BN(0), new BN(dataLength))
    runState.memory.extend(memOffset, dataLength)
    runState.memory.write(memOffset, dataLength, data)
  }
}

/** The first rule set of SSTORE rules, which are the rules pre-Constantinople and in Petersburg
 * @param {RunState} runState
 * @param {Buffer}   currentStorage
 * @param {Buffer}   value
 * @param {Buffer}   keyBuf
 */
export function updateSstoreGas(
  runState: RunState,
  currentStorage: Buffer,
  value: Buffer,
  keyBuf: Buffer,
  common: Common
) {
  const sstoreResetCost = common.param('gasPrices', 'sstoreReset')
  if (
    (value.length === 0 && !currentStorage.length) ||
    (value.length !== 0 && currentStorage.length)
  ) {
    runState.eei.useGas(
      new BN(adjustSstoreGasEIP2929(runState, keyBuf, sstoreResetCost, 'reset', common)),
      'updateSstoreGas'
    )
  } else if (value.length === 0 && currentStorage.length) {
    runState.eei.useGas(
      new BN(adjustSstoreGasEIP2929(runState, keyBuf, sstoreResetCost, 'reset', common)),
      'updateSstoreGas'
    )
    runState.eei.refundGas(new BN(common.param('gasPrices', 'sstoreRefund')), 'updateSstoreGas')
  } else if (value.length !== 0 && !currentStorage.length) {
    runState.eei.useGas(new BN(common.param('gasPrices', 'sstoreSet')), 'updateSstoreGas')
  }
}

export function mod(a: bigint, b: bigint) {
  let r = a % b
  if (r < 0n) {
    r = b + r
  }
  return r
}

export function fromTwos(a: bigint) {
  return BigInt.asUintN(256, ~(a - 1n))
}

export function toTwos(a: bigint) {
  return BigInt.asUintN(256, ~a) + 1n
}

export function abs(a: bigint) {
  if (a > 0) {
    return a
  }
  return a * -1n
}
