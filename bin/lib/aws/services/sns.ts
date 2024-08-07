import { awsFormRequest, LocalEnv } from '../lite.js'
import { jsonResponse, okResponse } from '@riddance/fetch'
import { isDeepStrictEqual } from 'node:util'
import { parseStringPromise as parseXml } from 'xml2js'

type Topic = { TopicArn: string }

type Subscriber = {
    protocol: 'lambda'
    endpoint: string
}

export async function asJson<T>(response: Awaited<ReturnType<typeof fetch>> | string) {
    const body = typeof response === 'string' ? response : await response.text()
    try {
        return JSON.parse(body) as T
    } catch {
        return (await parseXml(body, {
            explicitArray: false,
            explicitChildren: false,
            preserveChildrenOrder: true,
        })) as Promise<T>
    }
}

export function makeStatementData(functionId: string, topicArn: string) {
    return {
        Action: 'lambda:InvokeFunction',
        Effect: 'Allow',
        Principal: {
            Service: 'sns.amazonaws.com',
        },
        Resource: functionId,
        Condition: {
            ArnLike: {
                'AWS:SourceArn': topicArn,
            },
        },
    }
}

function makeSubscription(protocol: 'lambda', endpoint: string, topicArn: string) {
    return {
        Protocol: protocol,
        Endpoint: endpoint,
        TopicArn: topicArn,
    }
}
export async function ensureTopic(
    env: LocalEnv,
    topicName: string,
    { protocol, endpoint }: Subscriber,
) {
    const topics = await listTopics(env)
    const existing = topics.find(t => t.TopicArn.endsWith(`:${topicName}`))
    if (existing) {
        const subscriptions = await listSubscriptionsByTopic(env, existing.TopicArn)
        if (subscriptions.length === 0) {
            await subscribeTopic(env, existing.TopicArn, protocol, endpoint)
        } else if (
            !isDeepStrictEqual(
                subscriptions.map(({ SubscriptionArn: _, ...s }) => s),
                [makeSubscription(protocol, endpoint, existing.TopicArn)],
            )
        ) {
            await Promise.all(subscriptions.map(s => unsubscribeTopic(env, s.SubscriptionArn)))
            await subscribeTopic(env, existing.TopicArn, protocol, endpoint)
        }
        return existing.TopicArn
    }
    const createdTopicArn = await createTopic(env, topicName)
    await subscribeTopic(env, createdTopicArn, protocol, endpoint)
    return createdTopicArn
}
export async function listTopics(env: LocalEnv) {
    const topics: Topic[] = []
    let marker = ''
    for (;;) {
        const page = await jsonResponse<{
            ListTopicsResponse: {
                ListTopicsResult: {
                    NextToken: null | string
                    Topics: Topic[]
                }
            }
        }>(
            awsFormRequest(
                env,
                'POST',
                'sns',
                `/`,
                new URLSearchParams({
                    Action: 'ListTopics',
                    Version: '2010-03-31',
                    ...(marker && {
                        NextToken: marker,
                    }),
                }),
            ),
            `Error listing topics`,
        )
        topics.push(...page.ListTopicsResponse.ListTopicsResult.Topics)
        if (typeof page.ListTopicsResponse.ListTopicsResult.NextToken !== 'string') {
            break
        }
        marker = page.ListTopicsResponse.ListTopicsResult.NextToken
    }
    return topics
}

type Subscription = {
    Endpoint: string
    Protocol: 'lambda'
    TopicArn: string
    SubscriptionArn: string
}
export async function listSubscriptionsByTopic(env: LocalEnv, topicArn: string) {
    const subscriptions: Subscription[] = []
    let marker = ''
    for (;;) {
        const page = await jsonResponse<{
            ListSubscriptionsByTopicResponse: {
                ListSubscriptionsByTopicResult: {
                    NextToken: null | string
                    Subscriptions: Subscription[]
                }
            }
        }>(
            awsFormRequest(
                env,
                'POST',
                'sns',
                `/`,
                new URLSearchParams({
                    Action: 'ListSubscriptionsByTopic',
                    TopicArn: topicArn,
                    Version: '2010-03-31',
                    ...(marker && {
                        NextToken: marker,
                    }),
                }),
            ),
            `Error listing subscriptions by topic: ${topicArn}`,
        )
        subscriptions.push(
            ...page.ListSubscriptionsByTopicResponse.ListSubscriptionsByTopicResult.Subscriptions,
        )
        if (
            typeof page.ListSubscriptionsByTopicResponse.ListSubscriptionsByTopicResult
                .NextToken !== 'string'
        ) {
            break
        }
        marker = page.ListSubscriptionsByTopicResponse.ListSubscriptionsByTopicResult.NextToken
    }
    return subscriptions.map(s => {
        return {
            Endpoint: s.Endpoint,
            Protocol: s.Protocol,
            TopicArn: s.TopicArn,
            SubscriptionArn: s.SubscriptionArn,
        }
    })
}

export async function createTopic(env: LocalEnv, topicName: string) {
    const res = await awsFormRequest(
        env,
        'POST',
        'sns',
        '/',
        new URLSearchParams({
            Action: 'CreateTopic',
            Version: '2010-03-31',
            Name: topicName,
        }),
    )
    const { CreateTopicResponse } = await asJson<{
        CreateTopicResponse: { CreateTopicResult: { TopicArn: string } }
    }>(res)
    return CreateTopicResponse.CreateTopicResult.TopicArn
}

export function subscribeTopic(
    env: LocalEnv,
    topicArn: string,
    protocol: 'lambda',
    endpoint: string,
) {
    return okResponse(
        awsFormRequest(
            env,
            'POST',
            'sns',
            '/',
            new URLSearchParams({
                Action: 'Subscribe',
                Version: '2010-03-31',
                ...makeSubscription(protocol, endpoint, topicArn),
            }),
        ),
        `Error subscribing endpoint ${endpoint} to topic: ${topicArn}`,
    )
}

export function unsubscribeTopic(env: LocalEnv, subscriptionArn: string) {
    return okResponse(
        awsFormRequest(
            env,
            'POST',
            'sns',
            '/',
            new URLSearchParams({
                Action: 'Unsubscribe',
                Version: '2010-03-31',
                SubscriptionArn: subscriptionArn,
            }),
        ),
        `Error unsubscribing: ${subscriptionArn}`,
    )
}
