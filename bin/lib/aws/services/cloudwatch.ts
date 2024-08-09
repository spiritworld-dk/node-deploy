import { awsFormRequest, awsRequest, LocalEnv } from '../lite.js'
import { jsonResponse, okResponse } from '@riddance/fetch'
import { isDeepStrictEqual } from 'node:util'

type Alarm = {
    ActionsEnabled: boolean
    AlarmActions: string[] // Arns
    ComparisonOperator:
        | 'GreaterThanOrEqualToThreshold'
        | 'GreaterThanThreshold'
        | 'LessThanThreshold'
        | 'LessThanOrEqualToThreshold'
        | 'LessThanLowerOrGreaterThanUpperThreshold'
        | 'LessThanLowerThreshold'
        | 'GreaterThanUpperThreshold'
    DatapointsToAlarm: number
    EvaluationPeriods: number
    Period: number // seconds
    Statistic: 'SampleCount' | 'Average' | 'Sum' | 'Minimum' | 'Maximum'
    Threshold: number
    TreatMissingData: 'breaching' | 'notBreaching' | 'ignore' | 'missing'
    OKActions: string[]
}
export type AlarmConfig = Alarm
export async function setupAlarm(
    env: LocalEnv,
    logGroupName: string,
    metricName: string,
    metricNameSpace: string,
    config: {
        alarm?: AlarmConfig
        filterPattern?: string
        subject?: string
    },
    endpoint: string,
) {
    const [alarm, ...alarms] = await listAlarmsByMetric(env, metricName, metricNameSpace)
    if (alarm && alarms.length === 0) {
        const mergedConfig = {
            ...makeAlarm([endpoint], [endpoint]),
            ...config.alarm,
        }
        if (config?.alarm && !isDeepStrictEqual(alarm, mergedConfig)) {
            await putAlarm(env, metricName, metricNameSpace, mergedConfig)
        }
        return
    }
    if (alarms.length > 0) {
        console.warn(JSON.stringify(alarms, null, 2))
        throw new Error('Weird')
    }

    const metrics = await listMetrics(env, logGroupName)

    const metricFilter =
        metrics.find(m =>
            m.metricTransformations.find(
                t => t.metricName === metricName && t.metricNamespace === metricNameSpace,
            ),
        ) ??
        (await putMetricFilter(
            env,
            logGroupName,
            makeFilter(
                config?.subject ?? 'Errors',
                config?.filterPattern ?? 'ERROR',
                metricName,
                metricNameSpace,
            ),
        ))

    if (metricFilter) {
        if (config?.filterPattern && metricFilter.filterPattern !== config.filterPattern) {
            await putMetricFilter(
                env,
                logGroupName,
                makeFilter(
                    config.subject ?? 'errors',
                    config.filterPattern,
                    metricName,
                    metricNameSpace,
                ),
            )
        }
        await putAlarm(env, metricName, metricNameSpace, {
            ...makeAlarm([endpoint], [endpoint]),
            ...config?.alarm,
        })
    }
}
export async function listAlarmsByMetric(
    env: LocalEnv,
    metricName: string,
    metricNameSpace: string,
) {
    const { DescribeAlarmsForMetricResponse } = await jsonResponse<{
        DescribeAlarmsForMetricResponse: {
            DescribeAlarmsForMetricResult: {
                MetricAlarms: Alarm[]
            }
        }
    }>(
        awsFormRequest(
            env,
            'POST',
            'monitoring',
            `/`,
            new URLSearchParams({
                Action: 'DescribeAlarmsForMetric',
                Version: '2010-08-01',
                MetricName: metricName,
                Namespace: metricNameSpace,
            }),
        ),
        `Error listing alarms by metric: ${metricName}`,
    )
    return DescribeAlarmsForMetricResponse.DescribeAlarmsForMetricResult.MetricAlarms.map(m => {
        const {
            ActionsEnabled,
            AlarmActions,
            DatapointsToAlarm,
            OKActions,
            ComparisonOperator,
            EvaluationPeriods,
            Period,
            Statistic,
            Threshold,
            TreatMissingData,
        } = m
        return {
            ActionsEnabled,
            AlarmActions,
            DatapointsToAlarm,
            OKActions,
            ComparisonOperator,
            EvaluationPeriods,
            Period,
            Statistic,
            Threshold,
            TreatMissingData,
        }
    })
}
function makeFilter(
    filterName: string,
    filterPattern: string,
    metricName: string,
    metricNamespace: string,
) {
    return {
        filterName,
        filterPattern,
        metricTransformations: [
            {
                metricName,
                metricNamespace,
                metricValue: '1',
            },
        ],
    }
}
export async function putMetricFilter(
    env: LocalEnv,
    logGroupName: string,
    filter: ReturnType<typeof makeFilter>,
) {
    try {
        await okResponse(
            awsRequest(
                env,
                'POST',
                'logs',
                `/`,
                {
                    logGroupName,
                    ...filter,
                },
                {
                    'X-Amz-Target': 'Logs_20140328.PutMetricFilter',
                },
                'application/x-amz-json-1.1',
            ),
            `Error creating metrics filter for ${logGroupName}`,
        )
        return {
            ...filter,
        }
    } catch (err) {
        if (thrownHasCode(err, 'ResourceNotFoundException')) {
            await createLogGroup(env, logGroupName)
            return putMetricFilter(env, logGroupName, filter)
        }
        throw err
    }
}

async function createLogGroup(env: LocalEnv, logGroupName: string) {
    await okResponse(
        awsRequest(
            env,
            'POST',
            'logs',
            `/`,
            {
                logGroupName,
            },
            {
                'X-Amz-Target': 'Logs_20140328.CreateLogGroup',
            },
            'application/x-amz-json-1.1',
        ),
        `Error creating log group: ${logGroupName}`,
    )
}
export async function listMetrics(env: LocalEnv, logGroupName: string) {
    try {
        const { metricFilters } = await jsonResponse<{
            metricFilters: {
                filterName: string
                filterPattern: string
                logGroupName: string
                metricTransformations: {
                    defaultValue: unknown
                    metricValue: unknown
                    metricNamespace: string
                    metricName: string
                    dimensions: unknown
                    unit: unknown
                }[]
            }[]
        }>(
            awsRequest(
                env,
                'POST',
                'logs',
                `/`,
                {
                    logGroupName,
                },
                {
                    'X-Amz-Target': 'Logs_20140328.DescribeMetricFilters',
                },
                'application/x-amz-json-1.1',
            ),
            `Error listing metrics for ${logGroupName}`,
        )
        return metricFilters
    } catch (err) {
        if (thrownHasCode(err, 'ResourceNotFoundException')) {
            return []
        }
        throw err
    }
}
export function putAlarm(
    env: LocalEnv,
    metricName: string,
    metricNameSpace: string,
    alarm: ReturnType<typeof makeAlarm>,
) {
    return jsonResponse(
        awsRequest(
            env,
            'PUT',
            'monitoring',
            `/?${makeQuery({
                Action: 'PutMetricAlarm',
                Version: '2010-08-01',
                MetricName: metricName,
                Namespace: metricNameSpace,
                AlarmName: `${metricName}-alarm`,
                ...alarm,
            })}`,
            undefined,
        ),
        `Error creating alarm for metric filter: ${metricName}`,
    )
}

export function makeQuery(params: { [k: string]: string | string[] | boolean | number }) {
    return Object.entries(params)
        .map(p => p.join('='))
        .join('&')
}
export function makeAlarm(alarmActions: string[], okActions: string[]) {
    return {
        ActionsEnabled: true,
        ...spreadArray(alarmActions, 'AlarmActions.member.'),
        ...spreadArray(okActions, 'OKActions.member.'),
        ComparisonOperator: 'GreaterThanThreshold',
        DatapointsToAlarm: 1,
        EvaluationPeriods: 1,
        Period: 300,
        Statistic: 'Sum',
        Threshold: 0,
        TreatMissingData: 'notBreaching',
    }
}

function spreadArray(arr: string[], prefix: string) {
    return arr.reduce((acc, arn, i) => ({ ...acc, [`${prefix}${i + 1}`]: arn }), {})
}
export function thrownHasCode(e: unknown, code: string) {
    const body = (
        e as
            | {
                  response?: { body?: string }
              }
            | undefined
    )?.response?.body
    try {
        const { __type: c } = JSON.parse(body ?? '{}') as { __type: string }
        return c === code
    } catch {
        throw e
    }
}
