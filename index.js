const _ = require('lodash');

const Name = 'CognitoAddCustomAttributesPlugin';

const Params = {
  CognitoUserPoolIdOutputKey: 'CognitoUserPoolIdOutputKey',
  CustomAttributes: 'CustomAttributes',
  CognitoUserPoolClientIdOutputKey: 'CognitoUserPoolClientIdOutputKey',
};

class CognitoAddCustomAttributesPluginError extends Error {
  constructor(error, innerMessage) {
    super(error.message);
    this.name = 'CognitoAddCustomAttributesPluginError';
    
    this.innerMessage = innerMessage;
    Error.captureStackTrace(error, CognitoAddCustomAttributesPluginError);
  }
}

const loadCustom = (log, custom) => {
  let result = {};
  if (custom && custom.CognitoAddCustomAttributes) {

    const CognitoUserPoolIdOutputKey = _.get(custom.CognitoAddCustomAttributes, Params.CognitoUserPoolIdOutputKey);
    const CustomAttributes = _.get(custom.CognitoAddCustomAttributes, Params.CustomAttributes);
    const CognitoUserPoolClientIdOutputKey = _.get(custom.CognitoAddCustomAttributes, Params.CognitoUserPoolClientIdOutputKey);

    if (!CognitoUserPoolIdOutputKey || !(typeof(CognitoUserPoolIdOutputKey) === 'string')) {
      log('CognitoUserPoolIdOutputKey is required.');
    } else if (!CustomAttributes || !Array.isArray(CustomAttributes)) {
      log('CustomAttributes array is required.');
    } else {
      result.CognitoUserPoolIdOutputKey = CognitoUserPoolIdOutputKey;
      result.CustomAttributes = CustomAttributes;
      result.CognitoUserPoolClientIdOutputKey = CognitoUserPoolClientIdOutputKey;
    }
  }

  return result;
};

const describeStack = async (AWS) => {
  const response = await AWS.request('CloudFormation', 'describeStacks', { StackName: AWS.naming.getStackName() });
  return _.first(response.Stacks);
};

const findOutputId = (custom, stack, outputKey) => {
  if (stack) {
    const output = _.find(stack.Outputs, output => output.OutputKey === custom[outputKey]);
    if (output) {
      const outputId = _.get(output, 'OutputValue');
      return outputId;
    } else {
      throw new Error(`Could not find ${outputKey} in Outputs for stack.`);
    }
  }
};

const describeCognitoUserPool = async (AWS, userPoolId) => {
  try {
    const describeParams = {
      UserPoolId: userPoolId
    };

    const response = await AWS.request('CognitoIdentityServiceProvider', 'describeUserPool', describeParams);
    return response.UserPool;

  } catch (error) {
    throw new CognitoAddCustomAttributesPluginError(error, 'Error occurred when fetching UserPool');
  }
};

const describeCognitoUserPoolClient = async (AWS, userPoolId, userPoolClientId) => {
  try {
    const describeParams = {
      ClientId: userPoolClientId,
      UserPoolId: userPoolId
    };

    const response = await AWS.request('CognitoIdentityServiceProvider', 'describeUserPoolClient', describeParams);
    return response.UserPoolClient;

  } catch (error) {
    throw new CognitoAddCustomAttributesPluginError(error, 'Error occurred when fetching UserPoolClient');
  }
};

const transformAttributeName = (name) => {
  let customName = name;
  if (!_.startsWith(customName, 'custom:')) {
    customName = `custom:${customName}`;
  }
  return customName;
};

const getMissingAttributes = (newAttributes, existingAttributeNames) => {
  return _.filter(newAttributes, newAttribute => {

    let customName = transformAttributeName(newAttribute.Name);

    const exists = _.some(existingAttributeNames, existingName => existingName == customName);
    return !exists;
  });
};

const addNewCustomAttributesToUserPool = async (AWS, log, userPoolId, newAttributes) => {
  if (!_.isEmpty(newAttributes)) {
    try {
      const addCustomAttributesParams = {
        UserPoolId: userPoolId,
        CustomAttributes: newAttributes
      };

      log(`Adding ${newAttributes.length} attribute(s) to pool: ${_.join(_.map(newAttributes, x => x.Name))}`);

      await AWS.request('CognitoIdentityServiceProvider', 'addCustomAttributes', addCustomAttributesParams);
      log('Successfully added attributes to pool');

    } catch (error) {
      throw new CognitoAddCustomAttributesPluginError(error, 'Error occurred when adding attributes to pool');
    }
  } else {
    return log('Supplied attributes already exist in pool');
  }
};

const updateUserPoolClient = async (AWS, log, userPoolClient, readAttributes, writeAttributes) => {
  if (readAttributes.length + writeAttributes.length > 0) {

    const readAttributeNames = _.map(readAttributes, x => transformAttributeName(x.Name));
    const writeAttributeNames = _.map(writeAttributes, x => transformAttributeName(x.Name));

    try{
      let params = {
        ClientId: userPoolClient.ClientId,
        UserPoolId: userPoolClient.UserPoolId,
        ReadAttributes: _.concat(userPoolClient.ReadAttributes, readAttributeNames),
        WriteAttributes: _.concat(userPoolClient.WriteAttributes, writeAttributeNames),
      };
  
      if (readAttributeNames.length > 0 ) {
        log(`Enabling client to read from ${readAttributeNames.length} new attribute(s): ${_.join(readAttributeNames)}`);
      }
      if (writeAttributeNames.length > 0) {
        log(`Enabling client to write to ${writeAttributeNames.length} new attribute(s): ${_.join(writeAttributeNames)}`);
      }

      await AWS.request('CognitoIdentityServiceProvider', 'updateUserPoolClient', params);
      log('Successfully updated client');
    } catch(error) {
      throw new CognitoAddCustomAttributesPluginError(error, 'Error occurred when updating client');
    }
  } else {
    return log('No update required to UserPoolClient');
  }
};

class CognitoAddCustomAttributesPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = serverless.getProvider('aws');

    this.hooks = {
      'after:deploy:deploy': this.postDeploy.bind(this),
    };

    this.log = this.log.bind(this);
    this.run = this.run.bind(this);
  }

  postDeploy() {
    return new Promise((resolve, reject) => {
      this.custom = loadCustom(this.log, this.serverless.service.custom);

      if (_.has(this.custom, Params.CognitoUserPoolIdOutputKey) && _.has(this.custom, Params.CustomAttributes)) {
        return this.run().then(() => resolve());
      } else {
        this.log('Missing required fields.');
        return reject('Missing required fields.');
      }
    });
  }

  async run() {
    const { provider: AWS, custom, log } = this;

    try{
      log('Start');

      const stack = await describeStack(AWS);
      const userPoolId = findOutputId(custom, stack, Params.CognitoUserPoolIdOutputKey);
      log(`Found userPoolId: ${userPoolId}`);
      const userPoolClientId = await findOutputId(custom, stack, Params.CognitoUserPoolClientIdOutputKey);
      log(`Found userPoolClientId: ${userPoolClientId}`);

      const userPool = await describeCognitoUserPool(AWS, userPoolId);
      const userPoolClient = await describeCognitoUserPoolClient(AWS, userPoolId, userPoolClientId);
      
      const newAttributes = getMissingAttributes(custom.CustomAttributes, _.map(userPool.SchemaAttributes, 'Name'));
      await addNewCustomAttributesToUserPool(AWS, log, userPoolId, newAttributes);

      const newReadAttributes = getMissingAttributes(custom.CustomAttributes, userPoolClient.ReadAttributes);
      const newWriteAttributes = getMissingAttributes(custom.CustomAttributes, userPoolClient.WriteAttributes);
      await updateUserPoolClient(AWS, log, userPoolClient, newReadAttributes, newWriteAttributes);

      log('End');
    } catch(error) {
      if (error.innerMessage) log(`${error.innerMessage}. ${error}`);
    }
  }

  log(message) {
    this.serverless.cli.log(`${Name}: ${message}`);
  }
}

module.exports = CognitoAddCustomAttributesPlugin;
