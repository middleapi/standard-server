import { describe, expect, it } from 'vitest'

import { getOrBind } from './proxy'

describe('getOrBind', () => {
  it('returns non-function values directly', () => {
    const target = { foo: 'bar', baz: 123, obj: { a: 1 } }
    expect(getOrBind(target, 'foo')).toBe('bar')
    expect(getOrBind(target, 'baz')).toBe(123)
    expect(getOrBind(target, 'obj')).toBe(target.obj)
  })

  it('binds function values to the target', () => {
    const target = {
      name: 'target',
      getName() {
        return this?.name
      },
    }
    const boundGetName = getOrBind(target, 'getName')
    expect(typeof boundGetName).toBe('function')
    expect(boundGetName).not.toBe(target.getName)
    expect(boundGetName()).toBe('target')
  })

  it('caches the bound functions', () => {
    const target = {
      method() {},
    }
    const firstCall = getOrBind(target, 'method')
    const secondCall = getOrBind(target, 'method')
    expect(firstCall).toBe(secondCall)
  })

  it('caches are unique per target', () => {
    const method = function (this: any) {
      return this?.name
    }
    const target1 = { name: 't1', method }
    const target2 = { name: 't2', method }

    const bound1 = getOrBind(target1, 'method')
    const bound2 = getOrBind(target2, 'method')

    expect(bound1).not.toBe(bound2)
    expect(bound1()).toBe('t1')
    expect(bound2()).toBe('t2')
  })

  it('handles non-existent properties', () => {
    const target = {}
    expect(getOrBind(target, 'nonExistent' as any)).toBeUndefined()
  })

  it('handles symbol properties', () => {
    const sym = Symbol('test')
    const target = {
      [sym]() {
        return 'success'
      },
    }
    const bound = getOrBind(target, sym)
    expect(typeof bound).toBe('function')
    expect(bound()).toBe('success')
  })

  it('handles inherited properties', () => {
    class Base {
      baseMethod() {
        return 'base'
      }
    }
    class Derived extends Base {
      derivedMethod() {
        return 'derived'
      }
    }
    const target = new Derived()

    const boundBase = getOrBind(target, 'baseMethod')
    const boundDerived = getOrBind(target, 'derivedMethod')

    expect(boundBase()).toBe('base')
    expect(boundDerived()).toBe('derived')
  })

  it('works with getters that return functions', () => {
    const fn = function (this: any) {
      return this?.name
    }
    const target = {
      name: 'target',
      get dynamicFn() {
        return fn
      },
    }

    const bound = getOrBind(target, 'dynamicFn')
    expect(bound()).toBe('target')
    expect(getOrBind(target, 'dynamicFn')).toBe(bound)
  })

  it('we can disable binding', () => {
    const target = {
      method() {},
    }

    const bound = getOrBind(target, 'method', { bind: false })
    expect(bound).toBe(target.method)
  })
})
