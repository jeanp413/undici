'use strict'

const t = require('tap')
const { test } = t

const util = require('../../lib/fetch/util')
const { HeadersList } = require('../../lib/fetch/headers')

test('responseURL', (t) => {
  t.plan(2)

  t.ok(util.responseURL({
    urlList: [
      new URL('http://asd'),
      new URL('http://fgh')
    ]
  }))
  t.notOk(util.responseURL({
    urlList: []
  }))
})

test('responseLocationURL', (t) => {
  t.plan(3)

  const acceptHeaderList = new HeadersList()
  acceptHeaderList.append('Accept', '*/*')

  const locationHeaderList = new HeadersList()
  locationHeaderList.append('Location', 'http://asd')

  t.notOk(util.responseLocationURL({
    status: 200
  }))
  t.notOk(util.responseLocationURL({
    status: 301,
    headersList: acceptHeaderList
  }))
  t.ok(util.responseLocationURL({
    status: 301,
    headersList: locationHeaderList,
    urlList: [
      new URL('http://asd'),
      new URL('http://fgh')
    ]
  }))
})

test('requestBadPort', (t) => {
  t.plan(2)

  t.equal('allowed', util.requestBadPort({
    urlList: [new URL('https://asd')]
  }))
  t.equal('blocked', util.requestBadPort({
    urlList: [new URL('https://asd:7')]
  }))
})