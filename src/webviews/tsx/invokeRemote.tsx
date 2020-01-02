/*!
 * Copyright 2018-2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from 'react'
import * as ReactDOM from 'react-dom'

import { AwsComponent } from './components/awsComponent'
import { SelectDropDown } from './components/primitives/selectDropDown'
import { ValidityTextArea } from './components/primitives/validityTextArea'
import { generateDefaultValidityField, ValidityField, VsCode, VsCodeReactWebviewProp } from './interfaces/common'
import { InvokerState } from './interfaces/invoker'

declare const vscode: VsCode<InvokerState>

function generateDefaultInvokerState(): InvokerState {
    return {
        lambda: '',
        payload: generateDefaultValidityField(),
        region: '',
        template: '',
        availableTemplates: []
    }
}

export class Invoker extends AwsComponent<VsCodeReactWebviewProp<InvokerState>, InvokerState> {
    public render() {
        return (
            <div>
                <h1>
                    Calling Lambda function: {this.state.lambda} in Region: {this.state.region}
                </h1>
                <br />
                <SelectDropDown
                    name="template"
                    options={this.state.availableTemplates}
                    value={this.state.template}
                    setState={(key: string, value: string) =>
                        this.setSingleState<string>(key, value, () =>
                            this.props.vscode.postMessage({
                                message: this.state,
                                command: 'sampleRequestSelected'
                            })
                        )
                    }
                />
                <br />
                <ValidityTextArea
                    name="payload"
                    placeholder="JSON Payload"
                    validityField={this.state.payload}
                    setState={(key: string, value: ValidityField) => this.setSingleState<ValidityField>(key, value)}
                />
                <br />
                <button onClick={e => this.onSubmit(e)}>Submit!</button>
            </div>
        )
    }

    private onSubmit(event: React.MouseEvent) {
        try {
            // basic client-side validation test. We should probably offload something like this to the controller.
            JSON.parse(this.state.payload.value)
            this.setSingleState('payload', { ...this.state.payload, isValid: true }, () => {
                this.props.vscode.postMessage({
                    message: this.state,
                    command: 'invokeLambda'
                })
            })
        } catch (e) {
            this.setSingleState('payload', { ...this.state.payload, isValid: false })
        }
    }
}

ReactDOM.render(
    <Invoker vscode={vscode} defaultState={generateDefaultInvokerState()} />,
    document.getElementById('reactApp')
)
