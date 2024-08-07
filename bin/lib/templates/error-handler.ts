export const handler = async (event: SNSEvent) => {
    for (const e of event.Records) {
        const alarmEvent = JSON.parse(e.Sns.Message) as AlarmEvent
        if (alarmEvent.OldStateValue !== 'ALARM' && alarmEvent.OldStateValue !== 'OK') {
            return
        }
        await fetch(process.env.SLACK_WEBHOOK_URL ?? '', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(generateSlackMessage(alarmEvent)),
        }).then(res => {
            if (!res.ok) {
                console.warn(`Error posting to endpoint: ${process.env.SLACK_WEBHOOK_URL}`)
            }
        })
    }
}

function getDetails(event: AlarmEvent) {
    const [env, service, functionName] = event.AlarmName.split('-') as [string, string, string]
    return {
        env,
        service,
        functionName,
    }
}

function generateSlackMessage(event: AlarmEvent) {
    const { env, service, functionName } = getDetails(event)
    return {
        blocks: [
            {
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: `${event.NewStateValue === 'ALARM' ? ':x:' : ':white_check_mark:'} Alarm is ${event.NewStateValue === 'ALARM' ? 'down' : 'up'} for ${env}-${service}-${functionName} ${event.NewStateValue === 'ALARM' ? ':x:' : ':white_check_mark:'}`,
                },
            },
            {
                type: 'context',
                elements: [
                    {
                        text: getCloudwatchUrl(event),
                        type: 'mrkdwn',
                    },
                ],
            },
        ],
    }
}

function getCloudwatchUrl(event: AlarmEvent) {
    //https://eu-central-1.console.aws.amazon.com/cloudwatch/home?region=eu-central-1#alarmsV2:alarm/development-accounts-token-errors-alarm
    return `https://${getRegion(event.AlarmArn)}.console.aws.amazon.com/cloudwatch/home?region=${getRegion(event.AlarmArn)}#alarmsV2:alarm/${event.AlarmName}`
}

function getRegion(arn: string) {
    const [, , , region] = arn.split(':') as [string, string, string, string]
    return region
}

export type SNSMessage = {
    SignatureVersion: string
    Timestamp: string
    Signature: string
    SigningCertUrl: string
    MessageId: string
    Message: string
    MessageAttributes: unknown
    Type: string
    UnsubscribeUrl: string
    TopicArn: string
    Subject?: string
    Token?: string
}

export type SNSEventRecord = {
    EventVersion: string
    EventSubscriptionArn: string
    EventSource: string
    Sns: SNSMessage
}

export type SNSEvent = {
    Records: SNSEventRecord[]
}

type AlarmEvent = {
    AWSAccountId: '249499967976'
    AlarmActions: ['arn:aws:sns:eu-central-1:249499967976:staging-upload-alarm-errors']
    AlarmArn: 'arn:aws:cloudwatch:eu-central-1:249499967976:alarm:staging-upload-delete-errors-alarm'
    AlarmConfigurationUpdatedTimestamp: '2024-07-26T16:28:25.862+0000'
    AlarmDescription: null
    AlarmName: string // 'staging-upload-delete-errors-alarm'
    InsufficientDataActions: []
    NewStateReason: 'Threshold Crossed: 1 out of the last 1 datapoints [1.0 (26/07/24 17:12:00)] was greater than the threshold (0.0) (minimum 1 datapoint for OK -> ALARM transition).'
    NewStateValue: 'ALARM' | 'OK'
    OKActions: []
    OldStateValue: 'OK' | 'ALARM'
    Region: string // 'EU (Frankfurt)'
    StateChangeTime: string // '2024-07-26T17:17:43.813+0000'
    Trigger: {
        ComparisonOperator: 'GreaterThanThreshold'
        DatapointsToAlarm: 1
        Dimensions: []
        EvaluateLowSampleCountPercentile: ''
        EvaluationPeriods: 1
        MetricName: 'staging-upload-delete-errors'
        Namespace: 'staging-upload-errors'
        Period: 300
        Statistic: 'SUM'
        StatisticType: 'Statistic'
        Threshold: 0
        TreatMissingData: 'notBreaching'
        Unit: null
    }
}
