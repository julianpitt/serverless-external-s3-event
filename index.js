'use strict';

class S3Deploy {
  constructor(serverless, options) {
    this.serverless  = serverless;
    this.options     = options;
    this.service     = serverless.service;
    this.provider    = this.serverless.getProvider('aws');
    this.providerConfig = this.service.provider;
    this.functionPolicies = {};

    this.options.stage = this.options.stage
      || (this.serverless.service.provider && this.serverless.service.provider.stage)
      || 'dev';
    this.options.region = this.options.region
      || (this.serverless.service.provider && this.serverless.service.provider.region)
      || 'us-east-1';

    this.commands    = {
      s3deploy: {
        usage: 'Attaches lambda notification events to existing s3 buckets',
        lifecycleEvents: [
          'events'
        ],
        options: {
          stage: {
            usage: 'Stage of the service',
            shortcut: 's',
            required: false,
          },
          region: {
            usage: 'Region of the service',
            shortcut: 'r',
            required: false,
          },
        },
      },
      s3remove: {
        usage: 'Removes lambda notification events from existing s3 buckets',
        lifecycleEvents: [
          'events'
        ],
        options: {
          stage: {
            usage: 'Stage of the service',
            shortcut: 's',
            required: false,
          },
          region: {
            usage: 'Region of the service',
            shortcut: 'r',
            required: false,
          },
        },
      },
    };
    this.hooks = {

      // Serverless framework event hooks
      'before:deploy:deploy': this.checkBucketsExist.bind(this),
      'after:deploy:deploy': this.afterS3DeployFunctions.bind(this),
      'before:remove:remove': this.s3BucketRemoveEvent.bind(this),

      // External S3 event hooks
      'after:s3deploy:events': this.afterS3DeployFunctions.bind(this),
      'after:s3remove:events': this.s3BucketRemoveEvent.bind(this)

    };
  }

  checkBucketsExist() {

    this.serverless.cli.log(`Checking existing buckets actually exist`);

    let bucketNotifications = this.getBucketNotifications();
    
    //skip empty configs
    if (bucketNotifications.length === 0) {
      return Promise.resolve();
    }

    
    return this.provider.request('S3', 'listBuckets', {}, this.options.stage, this.options.region)
      .then((returnedBuckets)=>{

        if(!returnedBuckets.Buckets) {
          return Promise.reject('No buckets returned');  
        }

        const existingBuckets = returnedBuckets.Buckets.reduce((allBuckets, thisBucket) => {
          allBuckets.push(thisBucket.Name);
          return allBuckets;
        }, []);

        const expectedBuckets = bucketNotifications.reduce((allBuckets, thisBucket) => {
          allBuckets.push(thisBucket.Bucket);
          return allBuckets;
        }, []);

        const missingBuckets = expectedBuckets.filter(function (elem) {
            return existingBuckets.indexOf(elem) < 0;
        });

        if(missingBuckets.length > 0) {
          return Promise.reject(`Missing the following buckets: ${missingBuckets.join(',')}`);
        }

        return this.serverless.cli.log('All existing buckets actually exist');

      });
  }

  getBucketNotifications() {

    let funcObjs = this.service.getAllFunctions().map(name => this.service.getFunction(name));
    
    //turn functions into the config objects (flattened)
    let lambdaConfigs = funcObjs.map(obj => this.getLambdaFunctionConfigurationsFromFunction(obj))
    .reduce((flattened, c) => flattened = flattened.concat(c), []);

    //collate by bucket
    return lambdaConfigs.reduce((buckets, c) => {
      // TODO simplify this
      //find existing array with bucket name
      let bucketLambdaConfigs = buckets.find(existing => existing.Bucket === c.bucket);
      //otherwise create it
      if (!bucketLambdaConfigs) {
        bucketLambdaConfigs = { Bucket: c.bucket, NotificationConfiguration: { LambdaFunctionConfigurations: [] } };
        buckets.push(bucketLambdaConfigs);
      }
      //add config to notification
      bucketLambdaConfigs.NotificationConfiguration.LambdaFunctionConfigurations.push(c.config);
      return buckets;
    }, []);

  }

  getFunctionArnFromDeployedStack(info, deployedName) {

    let output = info.gatheredData.outputs.find((out) => {
      return out.OutputValue.indexOf(deployedName) !== -1;
    });

    if(output) {
      return Promise.resolve(output.OutputValue.replace(/:\d+$/, '')); //unless using qualifier?
    }

    // Unable to find the function in the output
    // Check if they explicitly stopped function versioning
    if(info.serverless.service.provider.versionFunctions === false) {
      
      return this.provider.request('Lambda', 'getFunction', {FunctionName: deployedName}, this.options.stage, this.options.region).then((functionInfo) => {
        return functionInfo.Configuration.FunctionArn;
      });

    }

    return Promise.reject('Unable to retreive function arn');
  }

  getLambdaFunctionConfigurationFromDeployedStack(info, bucket, cfg) {

    // TODO make this a separate method
    let results = info.gatheredData.info;

    let deployed = results.functions.find((fn) => fn.deployedName === cfg.LambdaFunctionArn);

    if (!deployed) {
      throw new Error("It looks like the function has not yet been deployed. You must use 'sls deploy' before doing 'sls s3deploy.");
    }
  
    return this.getFunctionArnFromDeployedStack(info, deployed.deployedName).then((arn) => {

      //replace placeholder ARN with final
      cfg.LambdaFunctionArn = arn;
      this.serverless.cli.log(`Attaching ${deployed.deployedName} to ${bucket.Bucket} ${cfg.Events}...`);

      //attach the bucket permission to the lambda
      return {
        Action: "lambda:InvokeFunction",
        FunctionName: deployed.deployedName,
        Principal: 's3.amazonaws.com',
        StatementId: `${deployed.deployedName}-${bucket.Bucket.replace(/[\.\:\*]/g,'')}`, // TODO hash the entire cfg? in case multiple
        //Qualifier to point at alias or version
        SourceArn: `arn:aws:s3:::${bucket.Bucket}`
      };

    });
  }

  afterS3DeployFunctions() {
    
    let bucketNotifications = this.getBucketNotifications();

    //skip empty configs
    if (bucketNotifications.length === 0) {
      return Promise.resolve();
    }

    //find the info plugin
    let info = this.serverless.pluginManager.getPlugins().find(i => i.constructor.name === 'AwsInfo');

    //use it to get deployed functions to check for things to attach to
    return info.getStackInfo().then(() => {

      let permsPromises = [];
      let buckets = [];
      let configPromises = [];

      bucketNotifications.forEach((bucket) => {

        //check this buckets notifications and replace the arn with the real one
        bucket.NotificationConfiguration.LambdaFunctionConfigurations.forEach((cfg) => {
          configPromises.push(this.getLambdaFunctionConfigurationFromDeployedStack(info, bucket, cfg));
        });

        //attach the event notification to the bucket
        buckets.push(bucket);

      });

      //run permsPromises before buckets
      return Promise.all(configPromises)
      .then((permConfigs) => { 
        permConfigs.map((permConfig) => {
          permsPromises.push(this.lambdaPermApi(permConfig));
        });
        return Promise.all(permsPromises);
      }).then(() => Promise.all(buckets.map((b) => this.s3EventApi(b))));
    })
    .then(() => this.serverless.cli.log('Done.'));
  }

  getLambdaFunctionConfigurationsFromFunction(functionObj) {
    return functionObj.events
    .filter(event => event.existingS3)
    .map(event => {
      let bucketEvents = event.existingS3.events || event.existingS3.bucketEvents || ['s3:ObjectCreated:*'];
      let eventRules = event.existingS3.rules || event.existingS3.eventRules || [];

      const returnObject = {
        bucket: event.existingS3.bucket,
        config: {
          Id: 'trigger-' + functionObj.name + '-when-' + bucketEvents.join().replace(/[\.\:\*]/g,''), // TODO hash the filter?
          LambdaFunctionArn: functionObj.name,
          Events: bucketEvents
        }
      };

      if (eventRules.length > 0) {
        returnObject.config.Filter = {};
        returnObject.config.Filter.Key = {};
        returnObject.config.Filter.Key.FilterRules = [];
      }

      eventRules.forEach(rule => {
        Object.keys(rule).forEach(key => {
          returnObject.config.Filter.Key.FilterRules.push({
            Name: key,
            Value: rule[key]
          });
        });
      });

      return returnObject;
    })
  }

  s3EventApi(cfg) {
    //this is read/modify/put
    return this.provider.request('S3', 'getBucketNotificationConfiguration', { Bucket: cfg.Bucket }, this.options.stage, this.options.region)
    .then((bucketConfig) => {
      //find lambda with our ARN or ID, replace it or add a new one
      cfg.NotificationConfiguration.LambdaFunctionConfigurations.forEach((ourcfg) => {
        let currentConfigIndex = bucketConfig.LambdaFunctionConfigurations.findIndex((s3cfg) => ourcfg.LambdaFunctionArn === s3cfg.LambdaFunctionArn || ourcfg.Id === s3cfg.Id);
        if (currentConfigIndex !== -1) {
          //just remove it
          bucketConfig.LambdaFunctionConfigurations.splice(currentConfigIndex, 1);
        }
        //push new config
        bucketConfig.LambdaFunctionConfigurations.push(ourcfg);
      });
      
      return { Bucket: cfg.Bucket, NotificationConfiguration: bucketConfig };

    }).then((cfg) => {
      return this.provider.request('S3', 'putBucketNotificationConfiguration', cfg, this.options.stage, this.options.region);
    });
  }

  lambdaPermApi(cfg) {
    //detect existing config with a read call
    //https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Lambda.html#getPolicy-property
    var existingPolicyPromise = null;
    if (this.functionPolicies[cfg.FunctionName]) {
      existingPolicyPromise = Promise.resolve(this.functionPolicies[cfg.FunctionName]);
    } else {
      existingPolicyPromise = this.provider.request('Lambda', 'getPolicy', { FunctionName: cfg.FunctionName }, this.options.stage, this.options.region)
      .then((result) => {
        let policy = JSON.parse(result.Policy);
        this.functionPolicies[cfg.FunctionName] = policy;
        return policy;
      })
      .catch((err) => {
        if(err.statusCode === 404){
          return Promise.resolve();
        }else{
          throw err;
        }
      });
    }

    return existingPolicyPromise.then((policy) => {
      //find our id
      let ourStatement = policy && policy.Statement.find((stmt) => stmt.Sid === cfg.StatementId);
      if (ourStatement) {
        //delete the statement before adding a new one
        return this.provider.request('Lambda', 'removePermission', { FunctionName: cfg.FunctionName, StatementId: cfg.StatementId }, this.options.stage, this.options.region);
      } else {
        //just resolve
        return Promise.resolve();
      }
    })
    .catch((err) => {
      //this one is going to handle the issue when Policy Permission not found.
      if(err.statusCode === 404 && err.toString() === 'ServerlessError: The resource you requested does not exist.'){
        return Promise.resolve();
      } else {
        return Promise.reject(err);
      }
    })
    .then(() => {
      //put the new policy
      return this.provider.request('Lambda', 'addPermission', cfg, this.options.stage, this.options.region);
    });
  }

  s3BucketRemoveEvent () {

    let bucketNotifications = this.getBucketNotifications();

    //skip if there are no configurations
    if (bucketNotifications.length === 0) {
      return Promise.resolve();
    }

    return Promise.all(bucketNotifications.map((cfg) => {

      return this.provider.request('S3', 'getBucketNotificationConfiguration', { Bucket: cfg.Bucket }, this.options.stage, this.options.region)
          .then((bucketConfig) => {

            let notificationConfig = {remove: false, params: {}};

            //find lambda with our ARN or ID, replace it or add a new one
            cfg.NotificationConfiguration.LambdaFunctionConfigurations.forEach((ourcfg) => {
              
              this.serverless.cli.log(`Removing ${ourcfg.LambdaFunctionArn} from ${cfg.Bucket} ${ourcfg.Events}...`);

              let currentConfigIndex = bucketConfig.LambdaFunctionConfigurations.findIndex((s3cfg) => ourcfg.LambdaFunctionArn === s3cfg.LambdaFunctionArn || ourcfg.Id === s3cfg.Id);
              if (currentConfigIndex !== -1) {

                //just remove it
                bucketConfig.LambdaFunctionConfigurations.splice(currentConfigIndex, 1);
                notificationConfig.remove = true;
              }

            });

            notificationConfig.params = { Bucket: cfg.Bucket, NotificationConfiguration: bucketConfig };

            return notificationConfig;

          })
          .then((cfg) => {
            
            if(!cfg.remove) {
              return;
            }

            return this.provider.request('S3', 'putBucketNotificationConfiguration', cfg.params, this.options.stage, this.options.region);
            
          });

      }))
      .then(() => this.serverless.cli.log('Removed all existing bucket events'));

  }

}

module.exports = S3Deploy;
