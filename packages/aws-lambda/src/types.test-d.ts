import type * as awsLambda from 'aws-lambda'

import type {
  AnyAPIGatewayProxyEvent,
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
  HttpResponseStream,
} from './types'

it('APIGatewayProxyEvent', () => {
  expectTypeOf<awsLambda.APIGatewayProxyEvent>().toExtend<APIGatewayProxyEvent>()
  expectTypeOf<awsLambda.APIGatewayProxyEvent>().not.toExtend<APIGatewayProxyEventV2>()
})

it('APIGatewayProxyEventV2', () => {
  expectTypeOf<awsLambda.APIGatewayProxyEventV2>().toExtend<APIGatewayProxyEventV2>()
  expectTypeOf<awsLambda.APIGatewayProxyEventV2>().not.toExtend<APIGatewayProxyEvent>()
})

it('AnyAPIGatewayProxyEvent', () => {
  const _v1: AnyAPIGatewayProxyEvent = {} as awsLambda.APIGatewayProxyEvent
  const _v2: AnyAPIGatewayProxyEvent = {} as awsLambda.APIGatewayProxyEventV2
})

it('HttpResponseStream', () => {
  expectTypeOf<Parameters<awsLambda.StreamifyHandler>[1]>().toExtend<HttpResponseStream>()
})
