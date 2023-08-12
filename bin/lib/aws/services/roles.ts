import { jsonResponse, okResponse, throwOnNotOK } from '@riddance/fetch'
import { Agent } from 'node:https'
import { setTimeout } from 'node:timers/promises'
import { LocalEnv, awsRequest } from '../lite.js'

export type AwsRole = {
    Arn: string
    AssumeRolePolicyDocument: string
    CreateDate: number
    Description: string
    MaxSessionDuration: number
    Path: string
    PermissionsBoundary: null
    RoleId: string
    RoleLastUsed: { LastUsedDate: number; Region: string }
    RoleName: string
    Tags: null
}

export async function getRole(
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    service: string,
): Promise<AwsRole | undefined> {
    const response = await awsRequest(
        agent,
        env,
        'GET',
        'iam',
        `?Action=GetRole&RoleName=${prefix}-${service}-role&Version=2010-05-08`,
    )

    if (response.status === 404) {
        return undefined
    }
    await throwOnNotOK(response, 'Error getting role')
    const body = (await response.json()) as {
        GetRoleResponse: {
            GetRoleResult: {
                Role: AwsRole
            }
        }
    }
    return body.GetRoleResponse.GetRoleResult.Role
}

export async function syncRole(
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    service: string,
    role: AwsRole | undefined,
) {
    role ??= await createRole(env, agent, prefix, service)
    return role.Arn
}

async function createRole(env: LocalEnv, agent: Agent, prefix: string, service: string) {
    console.log('creating role')
    const response = await jsonResponse<{
        CreateRoleResponse: {
            CreateRoleResult: {
                Role: AwsRole
            }
        }
    }>(
        awsRequest(
            agent,
            env,
            'GET',
            'iam',
            `?${new URLSearchParams({
                Action: 'CreateRole',
                Version: '2010-05-08',
                RoleName: `${prefix}-${service}-role`,
                AssumeRolePolicyDocument: JSON.stringify({
                    Version: '2012-10-17',
                    Statement: [
                        {
                            Effect: 'Allow',
                            Principal: {
                                Service: 'lambda.amazonaws.com',
                            },
                            Action: 'sts:AssumeRole',
                        },
                    ],
                }),
                'Tags.member.1.Key': 'framework',
                'Tags.member.1.Value': 'riddance',
                'Tags.member.2.Key': 'environment',
                'Tags.member.2.Value': prefix,
                'Tags.member.3.Key': 'service',
                'Tags.member.3.Value': service,
            }).toString()}`,
        ),
        'Error creating role',
    )
    await setTimeout(10000)
    return response.CreateRoleResponse.CreateRoleResult.Role
}

export async function assignPolicy(
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    service: string,
    region: string,
    account: string,
    additionalStatements: { Effect: string; Resource: string; Action: string[] }[],
) {
    console.log('assigning policy')
    await okResponse(
        awsRequest(
            agent,
            env,
            'GET',
            'iam',
            `?${new URLSearchParams({
                Action: 'PutRolePolicy',
                Version: '2010-05-08',
                RoleName: `${prefix}-${service}-role`,
                PolicyName: `${prefix}-${service}-policy`,
                PolicyDocument: JSON.stringify({
                    Version: '2012-10-17',
                    Statement: [
                        {
                            Effect: 'Allow',
                            Resource: `arn:aws:logs:${region}:${account}:*`,
                            Action: 'logs:CreateLogGroup',
                        },
                        {
                            Effect: 'Allow',
                            Resource: `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${prefix}-${service}-*`,
                            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                        },
                        {
                            Effect: 'Allow',
                            Resource: `arn:aws:dynamodb:${region}:${account}:table/${prefix}.${service}.*`,
                            Action: [
                                'dynamodb:CreateTable',
                                'dynamodb:BatchGetItem',
                                'dynamodb:ConditionCheckItem',
                                'dynamodb:PutItem',
                                'dynamodb:DeleteItem',
                                'dynamodb:GetItem',
                                'dynamodb:Scan',
                                'dynamodb:Query',
                                'dynamodb:UpdateItem',
                                'dynamodb:UpdateTable',
                                'dynamodb:GetRecords',
                                'dax:GetItem',
                                'dax:PutItem',
                                'dax:ConditionCheckItem',
                                'dax:BatchGetItem',
                                'dax:BatchWriteItem',
                                'dax:DeleteItem',
                                'dax:Query',
                                'dax:UpdateItem',
                                'dax:Scan',
                            ],
                        },
                        ...additionalStatements.map(as => ({
                            Effect: as.Effect,
                            Resource: as.Resource.replaceAll('$REGION', region).replaceAll(
                                '$ACCOUNT',
                                account,
                            ),
                            Action: as.Action,
                        })),
                    ],
                }),
            }).toString()}`,
        ),
        'Error assigning policy',
    )
}
