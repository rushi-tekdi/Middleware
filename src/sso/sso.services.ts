import { Injectable, StreamableFile } from '@nestjs/common';

//custom imports
import axios from 'axios';
import jwt_decode from 'jwt-decode';
import { createWriteStream, writeFile } from 'fs';
import { Response, Request } from 'express';
import * as wkhtmltopdf from 'wkhtmltopdf';
import { UserDto } from './dto/user-dto';
import { schoolList } from './constlist/schoollist';

@Injectable()
export class SSOService {
  //axios call
  md5 = require('md5');
  qs = require('qs');
  moment = require('moment');
  //keycloak config
  keycloakCred = {
    grant_type: 'client_credentials',
    client_id: process.env.KEYCLOAK_CLIENT_ID,
    client_secret: process.env.KEYCLOAK_CLIENT_SECRET,
  };
  //registerStudent
  async registerStudent(user: UserDto, response: Response) {
    if (user) {
      const clientToken = await this.getClientToken();
      if (clientToken?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_client_token_error',
          message: 'Bad Request for Keycloak Client Token',
          result: null,
        });
      } else {
        const issuerRes = await this.generateDid(user.studentId);
        if (issuerRes?.error) {
          return response.status(400).send({
            success: false,
            status: 'did_generate_error',
            message: 'DID Generate Failed. Try Again.',
            result: issuerRes?.error,
          });
        } else {
          var did = issuerRes[0].verificationMethod[0].controller;

          //register student keycloak
          let response_text = await this.registerStudentKeycloak(
            user,
            clientToken,
          );
          //comment
          if (response_text?.error) {
            return response.status(400).send({
              success: false,
              status: 'keycloak_register_duplicate',
              message: 'Student Already Registered in Keycloak',
              result: null,
            });
          } else {
            // sunbird registery
            let sb_rc_response_text = await this.sbrcRegistery(did, user);

            if (sb_rc_response_text?.error) {
              return response.status(400).send({
                success: false,
                status: 'sb_rc_register_error',
                message: 'Sunbird RC Student Registration Failed',
                result: sb_rc_response_text?.error,
              });
            } else if (sb_rc_response_text?.params?.status === 'SUCCESSFUL') {
              return response.status(201).send({
                success: true,
                status: 'registered',
                message:
                  'Student Account Created in Keycloak and Registered in Sunbird RC',
                result: sb_rc_response_text,
              });
            } else {
              return response.status(400).send({
                success: false,
                status: 'sb_rc_register_duplicate',
                message: 'Student Already Registered in Sunbird RC',
                result: sb_rc_response_text,
              });
            }
          }
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //loginStudent
  async loginStudent(username: string, password: string, response: Response) {
    if (username && password) {
      const studentToken = await this.getKeycloakToken(username, password);
      if (studentToken?.error) {
        return response.status(501).send({
          success: false,
          status: 'keycloak_invalid_credentials',
          message: studentToken?.error.message,
          result: null,
        });
      } else {
        const sb_rc_search = await this.searchStudent(username);
        if (sb_rc_search?.error) {
          return response.status(501).send({
            success: false,
            status: 'sb_rc_search_error',
            message: 'Sunbird RC Student Search Failed',
            result: sb_rc_search?.error,
          });
        } else if (sb_rc_search.length !== 1) {
          return response.status(404).send({
            success: false,
            status: 'sb_rc_no_found',
            message: 'Student Not Found in Sunbird RC',
            result: null,
          });
        } else {
          return response.status(200).send({
            success: true,
            status: 'login_success',
            message: 'Login Success',
            result: {
              userData: sb_rc_search,
              token: studentToken?.access_token,
            },
          });
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //getDIDStudent
  async getDIDStudent(studentid: string, response: Response) {
    if (studentid) {
      const sb_rc_search = await this.searchStudent(studentid);
      if (sb_rc_search?.error) {
        return response.status(501).send({
          success: false,
          status: 'sb_rc_search_error',
          message: 'Sunbird RC Student Search Failed',
          result: null,
        });
      } else if (sb_rc_search.length !== 1) {
        return response.status(404).send({
          success: false,
          status: 'sb_rc_no_did_found',
          message: 'Student DID not Found in Sunbird RC',
          result: null,
        });
      } else {
        return response.status(200).send({
          success: true,
          status: 'did_success',
          message: 'DID Found',
          result: sb_rc_search[0]?.did ? sb_rc_search[0].did : '',
        });
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //credentialsStudent
  async credentialsStudent(token: string, response: Response) {
    if (token) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_student_token_bad_request',
          message: 'Unauthorized',
          result: null,
        });
      } else if (!studentUsername?.preferred_username) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_student_token_error',
          message: 'Keycloak Student Token Expired',
          result: null,
        });
      } else {
        const sb_rc_search = await this.searchStudent(
          studentUsername?.preferred_username,
        );
        if (sb_rc_search?.error) {
          return response.status(501).send({
            success: false,
            status: 'sb_rc_search_error',
            message: 'Sunbird RC Student Search Failed',
            result: sb_rc_search?.error.message,
          });
        } else if (sb_rc_search.length !== 1) {
          return response.status(404).send({
            success: false,
            status: 'sb_rc_no_did_found',
            message: 'Student DID not Found in Sunbird RC',
            result: null,
          });
        } else {
          let cred_search = await this.credSearch(sb_rc_search);

          if (cred_search?.error) {
            return response.status(501).send({
              success: false,
              status: 'cred_search_error',
              message: 'Student Credentials Search Failed',
              result: cred_search?.error,
            });
          } else if (cred_search.length === 0) {
            return response.status(404).send({
              success: false,
              status: 'cred_search_no_found',
              message: 'Student Credentials Not Found',
              result: null,
            });
          } else {
            return response.status(200).send({
              success: true,
              status: 'cred_success',
              message: 'Student Credentials Found',
              result: cred_search,
            });
          }
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received token.',
        result: null,
      });
    }
  }

  //renderCredentials
  async renderCredentials(
    token: string,
    requestbody: any,
  ): Promise<string | StreamableFile> {
    if (token) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return 'Keycloak Student Token Expired';
      } else if (!studentUsername?.preferred_username) {
        return 'Keycloak Student Token Expired';
      } else {
        var data = JSON.stringify(requestbody);

        var config = {
          method: 'post',
          url: process.env.CRED_URL + '/credentials/render',
          headers: {
            'Content-Type': 'application/json',
          },
          data: data,
        };

        let render_response = null;
        await axios(config)
          .then(function (response) {
            render_response = response.data;
          })
          .catch(function (error) {
            //console.log(error);
          });
        if (render_response == null) {
          return 'Cred Render API Failed';
        } else {
          //return render_response;
          try {
            return new StreamableFile(
              await wkhtmltopdf(render_response, {
                pageSize: 'A4',
                disableExternalLinks: true,
                disableInternalLinks: true,
                disableJavascript: true,
              }),
            );
          } catch (e) {
            //console.log(e);
            return 'HTML to PDF Convert Fail';
          }
        }
      }
    } else {
      return 'Student Token Not Received';
    }
  }

  //renderCredentialsHTML
  async renderCredentialsHTML(
    token: string,
    requestbody: any,
    response: Response,
  ) {
    if (token) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_student_token_bad_request',
          message: 'Unauthorized',
          result: null,
        });
      } else if (!studentUsername?.preferred_username) {
        return response.status(400).send({
          success: false,
          status: 'keycloak_student_token_error',
          message: 'Keycloak Student Token Expired',
          result: null,
        });
      } else {
        var data = JSON.stringify(requestbody);

        var config = {
          method: 'post',
          url: process.env.CRED_URL + '/credentials/render',
          headers: {
            'Content-Type': 'application/json',
          },
          data: data,
        };

        let render_response = null;
        await axios(config)
          .then(function (response) {
            //console.log(JSON.stringify(response.data));
            render_response = response.data;
          })
          .catch(function (error) {
            //console.log(error);
          });
        if (render_response == null) {
          return response.status(400).send({
            success: false,
            status: 'render_api_failed',
            message: 'Cred Render API Failed',
            result: null,
          });
        } else {
          return response.status(200).send({
            success: true,
            status: 'render_api_success',
            message: 'Cred Render API Success',
            result: render_response,
          });
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received token.',
        result: null,
      });
    }
  }

  //renderTemplate
  async renderTemplate(id: string, response: Response) {
    if (id) {
      var config = {
        method: 'get',
        url: process.env.SCHEMA_URL + '/rendering-template?id=' + id,
        headers: {},
      };
      let response_text = null;
      await axios(config)
        .then(function (response) {
          //console.log(JSON.stringify(response.data));
          response_text = response.data;
        })
        .catch(function (error) {
          //console.log(error);
        });
      if (response_text == null) {
        return response.status(400).send({
          success: false,
          status: 'render_template_api_failed',
          message: 'Render Template API Failed',
          result: null,
        });
      } else {
        return response.status(200).send({
          success: true,
          status: 'render_template_api_success',
          message: 'Render Template API Success',
          result: response_text,
        });
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //renderTemplateSchema
  async renderTemplateSchema(id: string, response: Response) {
    if (id) {
      var config = {
        method: 'get',
        url: process.env.SCHEMA_URL + '/rendering-template/' + id,
        headers: {},
      };
      let response_text = null;
      await axios(config)
        .then(function (response) {
          //console.log(JSON.stringify(response.data));
          response_text = response.data;
        })
        .catch(function (error) {
          //console.log(error);
        });
      if (response_text == null) {
        return response.status(400).send({
          success: false,
          status: 'render_template_schema_api_failed',
          message: 'Render Template Schema API Failed',
          result: null,
        });
      } else {
        return response.status(200).send({
          success: true,
          status: 'render_template_schema_api_success',
          message: 'Render Template Schema API Success',
          result: response_text,
        });
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //credentialsSearch
  async credentialsSearch(token: string, requestbody: any, response: Response) {
    if (token && requestbody) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_token_bad_request',
          message: 'Unauthorized',
          result: null,
        });
      } else if (!studentUsername?.preferred_username) {
        return response.status(400).send({
          success: false,
          status: 'keycloak_token_error',
          message: 'Keycloak Token Expired',
          result: null,
        });
      } else {
        var data = JSON.stringify(requestbody);
        var config = {
          method: 'post',
          url: process.env.CRED_URL + '/credentials/search',
          headers: {
            'Content-Type': 'application/json',
          },
          data: data,
        };

        let render_response = null;
        await axios(config)
          .then(function (response) {
            //console.log(JSON.stringify(response.data));
            render_response = response.data;
          })
          .catch(function (error) {
            //console.log(error);
            render_response = { error: error };
          });

        if (render_response?.error) {
          return response.status(400).send({
            success: false,
            status: 'cred_search_api_failed',
            message: 'Cred Search API Failed',
            result: render_response,
          });
        } else {
          return response.status(200).send({
            success: true,
            status: 'cred_search_api_success',
            message: 'Cred Search API Success',
            result: render_response,
          });
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received token or requestbody.',
        result: null,
      });
    }
  }

  //credentialsIssue
  async credentialsIssue(token: string, requestbody: any, response: Response) {
    if (token && requestbody) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_bad_request',
          message: 'Unauthorized',
          result: null,
        });
      } else if (!studentUsername?.preferred_username) {
        return response.status(400).send({
          success: false,
          status: 'keycloak_token_error',
          message: 'Keycloak Token Expired',
          result: null,
        });
      } else {
        var data = JSON.stringify(requestbody);
        var config = {
          method: 'post',
          url: process.env.CRED_URL + '/credentials/issue',
          headers: {
            'Content-Type': 'application/json',
          },
          data: data,
        };

        let render_response = null;
        await axios(config)
          .then(function (response) {
            //console.log(JSON.stringify(response.data));
            render_response = response.data;
          })
          .catch(function (error) {
            //console.log(error);
            render_response = { error: error };
          });

        if (render_response?.error) {
          return response.status(400).send({
            success: false,
            status: 'cred_issue_api_failed',
            message: 'Cred Issue API Failed',
            result: render_response,
          });
        } else {
          return response.status(200).send({
            success: true,
            status: 'cred_issue_api_success',
            message: 'Cred Issue API Success',
            result: render_response,
          });
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received token or requestbody.',
        result: null,
      });
    }
  }

  //credentialsSchema
  async credentialsSchema(id: string, response: Response) {
    if (id) {
      var config = {
        method: 'get',
        url: process.env.CRED_URL + '/credentials/schema/' + id,
        headers: {},
      };
      let response_text = null;
      await axios(config)
        .then(function (response) {
          //console.log(JSON.stringify(response.data));
          response_text = response.data;
        })
        .catch(function (error) {
          //console.log(error);
          response_text = { error: error };
        });
      if (response_text?.error) {
        return response.status(400).send({
          success: false,
          status: 'cred_schema_api_failed',
          message: 'Cred Schema API Failed',
          result: response_text,
        });
      } else {
        return response.status(200).send({
          success: true,
          status: 'cred_schema_api_success',
          message: 'Cred Schema API Success',
          result: response_text,
        });
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //credentialsSchemaJSON
  async credentialsSchemaJSON(id: string, response: Response) {
    if (id) {
      var config = {
        method: 'get',
        url: process.env.SCHEMA_URL + '/schema/jsonld?id=' + id,
        headers: {},
      };
      let response_text = null;
      await axios(config)
        .then(function (response) {
          //console.log(JSON.stringify(response.data));
          response_text = response.data;
        })
        .catch(function (error) {
          //console.log(error);
          response_text = { error: error };
        });
      if (response_text?.error) {
        return response.status(400).send({
          success: false,
          status: 'cred_schema_json_api_failed',
          message: 'Cred Schema JSON API Failed',
          result: response_text,
        });
      } else {
        return response.status(200).send({
          success: true,
          status: 'cred_schema_json_api_success',
          message: 'Cred Schema JSON API Success',
          result: response_text,
        });
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //userData
  async userData(token: string, digiacc: string, response: Response) {
    if (token && digiacc) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_user_token_bad_request',
          message: 'Unauthorized',
          result: null,
        });
      } else if (!studentUsername?.preferred_username) {
        return response.status(400).send({
          success: false,
          status: 'keycloak_user_token_error',
          message: 'Keycloak User Token Expired',
          result: null,
        });
      } else {
        //get user detail
        //find if student account present in sb rc or not
        const sb_rc_search = await this.searchUsernameEntity(
          digiacc === 'ewallet' ? 'StudentV2' : 'TeacherV1',
          studentUsername?.preferred_username,
        );
        //console.log(sb_rc_search);
        if (sb_rc_search?.error) {
          return response.status(501).send({
            success: false,
            status: 'sb_rc_search_error',
            message: 'Sunbird RC User Search Failed',
            result: sb_rc_search?.error,
          });
        } else if (sb_rc_search.length === 0) {
          // no student found then register
          return response.status(501).send({
            success: false,
            status: 'sb_rc_search_no_found',
            message: 'Sunbird RC User No Found',
            result: sb_rc_search?.error,
          });
        } else {
          //check if user is private or public
          if (sb_rc_search[0]?.school_type === 'private') {
            //find if student private detaile
            const filter = {
              filters: {
                student_id: {
                  eq: sb_rc_search[0].osid,
                },
              },
            };
            const sb_rc_search_detail = await this.searchEntity(
              'StudentDetailV2',
              filter,
            );
            //console.log(sb_rc_search_detail);
            if (sb_rc_search_detail?.error) {
              return response.status(501).send({
                success: false,
                status: 'sb_rc_search_error',
                message: 'Sunbird RC User Search Failed',
                result: sb_rc_search_detail?.error,
              });
            } else if (sb_rc_search_detail.length === 0) {
              // no student found then register
              return response.status(501).send({
                success: false,
                status: 'sb_rc_search_no_found',
                message: 'Sunbird RC User No Found',
                result: sb_rc_search_detail?.error,
              });
            } else {
              //sent user value
              return response.status(200).send({
                success: true,
                status: 'sb_rc_search_found',
                message: 'Sunbird RC User Found',
                result: sb_rc_search[0],
                detail: sb_rc_search_detail[0],
              });
            }
          } else {
            //sent user value
            return response.status(200).send({
              success: true,
              status: 'sb_rc_search_found',
              message: 'Sunbird RC User Found',
              result: sb_rc_search[0],
              detail: null,
            });
          }
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received token or acc type.',
        result: null,
      });
    }
  }

  //schoolData
  async schoolData(token: string, udise: string, response: Response) {
    if (token && udise) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_user_token_bad_request',
          message: 'Unauthorized',
          result: null,
        });
      } else if (!studentUsername?.preferred_username) {
        return response.status(400).send({
          success: false,
          status: 'keycloak_user_token_error',
          message: 'Keycloak User Token Expired',
          result: null,
        });
      } else {
        //get user detail
        //find if student account present in sb rc or not
        const sb_rc_search = await this.searchUdiseEntity(
          'SchoolDetail',
          udise,
        );
        if (sb_rc_search?.error) {
          return response.status(501).send({
            success: false,
            status: 'sb_rc_search_error',
            message: 'Sunbird RC School Search Failed',
            result: sb_rc_search?.error,
          });
        } else if (sb_rc_search.length === 0) {
          // no student found then register
          return response.status(501).send({
            success: false,
            status: 'sb_rc_search_no_found',
            message: 'Sunbird RC School No Found',
            result: sb_rc_search?.error,
          });
        } else {
          //sent user value
          return response.status(200).send({
            success: true,
            status: 'sb_rc_search_found',
            message: 'Sunbird RC School Found',
            result: sb_rc_search[0],
          });
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received token or udise.',
        result: null,
      });
    }
  }

  //digilockerAuthorize
  async digilockerAuthorize(digiacc: string, response: Response) {
    //console.log(request);
    let digi_client_id = '';
    let digi_url_call_back_uri = '';
    if (digiacc === 'ewallet') {
      digi_client_id = process.env.EWA_CLIENT_ID;
      digi_url_call_back_uri = process.env.EWA_CALL_BACK_URL;
    } else if (digiacc === 'portal') {
      digi_client_id = process.env.URP_CLIENT_ID;
      digi_url_call_back_uri = process.env.URP_CALL_BACK_URL;
    }
    response.status(200).send({
      digiauthurl: `https://digilocker.meripehchaan.gov.in/public/oauth2/1/authorize?client_id=${digi_client_id}&response_type=code&redirect_uri=${digi_url_call_back_uri}&state=${digiacc}`,
    });
  }

  //digilockerToken
  async digilockerToken(
    response: Response,
    digiacc: string,
    auth_code: string,
  ) {
    if (digiacc && auth_code) {
      let digi_client_id = '';
      let digi_client_secret = '';
      let digi_url_call_back_uri = '';
      if (digiacc === 'ewallet') {
        digi_client_id = process.env.EWA_CLIENT_ID;
        digi_client_secret = process.env.EWA_CLIENT_SECRET;
        digi_url_call_back_uri = process.env.EWA_CALL_BACK_URL;
      } else if (digiacc === 'portal') {
        digi_client_id = process.env.URP_CLIENT_ID;
        digi_client_secret = process.env.URP_CLIENT_SECRET;
        digi_url_call_back_uri = process.env.URP_CALL_BACK_URL;
      }
      var data = this.qs.stringify({
        code: auth_code,
        grant_type: 'authorization_code',
        client_id: digi_client_id,
        client_secret: digi_client_secret,
        redirect_uri: digi_url_call_back_uri,
      });
      var config = {
        method: 'post',
        url: 'https://digilocker.meripehchaan.gov.in/public/oauth2/2/token',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: data,
      };

      let response_digi = null;
      await axios(config)
        .then(function (response) {
          //console.log(JSON.stringify(response.data));
          response_digi = { data: response.data };
        })
        .catch(function (error) {
          //console.log(error);
          response_digi = { error: null };
        });
      if (response_digi?.error) {
        return response.status(401).send({
          success: false,
          status: 'digilocker_token_bad_request',
          message: 'Unauthorized',
          result: response_digi?.error,
        });
      } else {
        let id_token = response_digi?.data?.id_token;
        if (id_token) {
          let token_data: Object = await this.parseJwt(id_token);
          if (!token_data[0]?.sub) {
            return response.status(401).send({
              success: false,
              status: 'digilocker_token_bad_request',
              message: 'Unauthorized',
              result: response_digi?.error,
            });
          } else {
            const dob = await this.convertDate(token_data[0]?.birthdate);
            const username_name = token_data[0]?.given_name.split(' ')[0];
            const username_dob = await this.replaceChar(dob, '/', '');
            let auto_username = username_name + '@' + username_dob;
            auto_username = auto_username.toLowerCase();
            let response_data = {
              meripehchanid: token_data[0]?.sub,
              name: token_data[0]?.given_name,
              mobile: token_data[0]?.phone_number,
              dob: dob,
              username: auto_username,
            };
            const sb_rc_search = await this.searchDigiEntity(
              digiacc === 'ewallet' ? 'StudentV2' : 'TeacherV1',
              digiacc === 'ewallet'
                ? {
                    filters: {
                      meripehchan_id: {
                        eq: response_data?.meripehchanid.toString(),
                      },
                    },
                  }
                : {
                    filters: {
                      meripehchanLoginId: {
                        eq: response_data?.meripehchanid.toString(),
                      },
                    },
                  },
            );
            if (sb_rc_search?.error) {
              return response.status(501).send({
                success: false,
                status: 'sb_rc_search_error',
                message: 'Sunbird RC Search Failed',
                result: sb_rc_search?.error.message,
              });
            } else if (sb_rc_search.length === 0) {
              return response.status(200).send({
                success: true,
                status: 'digilocker_login_success',
                message: 'Digilocker Login Success',
                result: response_data,
                digi: response_digi?.data,
                user: 'NO_FOUND',
              });
            } else {
              let auto_username =
                digiacc === 'ewallet'
                  ? response_data?.username
                  : response_data?.meripehchanid + '_teacher';
              auto_username = auto_username.toLowerCase();
              const auto_password = await this.md5(
                auto_username + 'MjQFlAJOQSlWIQJHOEDhod',
              );
              const userToken = await this.getKeycloakToken(
                auto_username,
                auto_password,
              );
              if (userToken?.error) {
                //console.log(userToken?.error);
                /*return response.status(501).send({
                  success: false,
                  status: 'keycloak_invalid_credentials',
                  message: userToken?.error.message,
                  result: null,
                });*/
                return response.status(200).send({
                  success: true,
                  status: 'digilocker_login_success',
                  message: 'Digilocker Login Success',
                  result: response_data,
                  digi: response_digi?.data,
                  user: 'NO_FOUND',
                });
              } else {
                if (sb_rc_search[0]?.school_type === 'private') {
                  //find if student private detaile
                  const filter = {
                    filters: {
                      student_id: {
                        eq: sb_rc_search[0].osid,
                      },
                    },
                  };
                  const sb_rc_search_detail = await this.searchEntity(
                    'StudentDetailV2',
                    filter,
                  );
                  //console.log(sb_rc_search_detail);
                  if (sb_rc_search_detail?.error) {
                    return response.status(501).send({
                      success: false,
                      status: 'sb_rc_search_error',
                      message: 'Sunbird RC User Search Failed',
                      result: sb_rc_search_detail?.error,
                    });
                  } else if (sb_rc_search_detail.length === 0) {
                    // no student found then register
                    return response.status(501).send({
                      success: false,
                      status: 'sb_rc_search_no_found',
                      message: 'Sunbird RC User No Found',
                      result: sb_rc_search_detail?.error,
                    });
                  } else {
                    //sent user value
                    return response.status(200).send({
                      success: true,
                      status: 'digilocker_login_success',
                      message: 'Digilocker Login Success',
                      result: response_data,
                      digi: response_digi?.data,
                      user: 'FOUND',
                      userData: sb_rc_search,
                      detail: sb_rc_search_detail[0],
                      token: userToken?.access_token,
                    });
                  }
                } else {
                  return response.status(200).send({
                    success: true,
                    status: 'digilocker_login_success',
                    message: 'Digilocker Login Success',
                    result: response_data,
                    digi: response_digi?.data,
                    user: 'FOUND',
                    userData: sb_rc_search,
                    detail: null,
                    token: userToken?.access_token,
                  });
                }
              }
            }
          }
        } else {
          return response.status(401).send({
            success: false,
            status: 'digilocker_token_bad_request',
            message: 'Unauthorized',
            result: response_digi?.error,
          });
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  //digilockerRegister
  async digilockerRegister(
    response: Response,
    digiacc: string,
    userdata: any,
    digimpid: string,
  ) {
    if (digiacc && userdata && digimpid) {
      const clientToken = await this.getClientToken();
      if (clientToken?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_client_token_error',
          message: 'Bad Request for Keycloak Client Token',
          result: null,
        });
      } else {
        //register in keycloak
        let auto_username =
          digiacc === 'ewallet'
            ? userdata?.student?.username
            : digimpid + '_teacher';
        auto_username = auto_username.toLowerCase();
        const auto_password = await this.md5(
          auto_username + 'MjQFlAJOQSlWIQJHOEDhod',
        );
        //register student keycloak
        let response_text = await this.registerUserKeycloak(
          auto_username,
          auto_password,
          clientToken,
        );

        if (response_text?.error) {
          return response.status(400).send({
            success: false,
            status: 'keycloak_register_duplicate',
            message: 'User Already Registered in Keycloak',
            result: null,
          });
        } else {
          //ewallet registration student
          if (digiacc === 'ewallet') {
            //find if student account present in sb rc or not
            const sb_rc_search = await this.sbrcStudentSearch(
              userdata?.student?.student_name,
              userdata?.student?.dob,
            );
            //console.log(sb_rc_search);
            if (sb_rc_search?.error) {
              return response.status(501).send({
                success: false,
                status: 'sb_rc_search_error',
                message: 'Sunbird RC Student Search Failed',
                result: sb_rc_search?.error,
              });
            } else if (sb_rc_search.length === 0) {
              // no student found then register
              // sunbird registery student
              userdata.student.reference_id =
                'ULP_' + userdata.student.student_id;
              userdata.student.school_type = 'private';
              let sb_rc_response_text = await this.sbrcInvite(
                userdata.student,
                'StudentV2',
              );
              if (sb_rc_response_text?.error) {
                return response.status(400).send({
                  success: false,
                  status: 'sb_rc_register_error',
                  message: 'Sunbird RC Student Registration Failed',
                  result: sb_rc_response_text?.error,
                });
              } else if (sb_rc_response_text?.params?.status === 'SUCCESSFUL') {
                //find osid of student and add detail in student details
                // sunbird registery student detail
                userdata.studentdetail.student_id =
                  sb_rc_response_text?.result?.StudentV2?.osid;
                userdata.studentdetail.claim_status = 'pending';
                let sb_rc_response_text_detail = await this.sbrcInvite(
                  userdata.studentdetail,
                  'StudentDetailV2',
                );
                if (sb_rc_response_text_detail?.error) {
                  return response.status(400).send({
                    success: false,
                    status: 'sb_rc_register_error',
                    message: 'Sunbird RC Student Registration Failed',
                    result: sb_rc_response_text_detail?.error,
                  });
                } else if (
                  sb_rc_response_text_detail?.params?.status === 'SUCCESSFUL'
                ) {
                } else {
                  return response.status(400).send({
                    success: false,
                    status: 'sb_rc_register_duplicate',
                    message: 'Student Already Registered in Sunbird RC',
                    result: sb_rc_response_text_detail,
                  });
                }
              } else {
                return response.status(400).send({
                  success: false,
                  status: 'sb_rc_register_duplicate',
                  message: 'Student Already Registered in Sunbird RC',
                  result: sb_rc_response_text,
                });
              }
            } else {
              //update value found id
              const osid = sb_rc_search[0]?.osid;
              userdata.student.DID = sb_rc_search[0]?.DID;
              // sunbird registery student
              let sb_rc_response_text = await this.sbrcUpdate(
                {
                  meripehchan_id: userdata?.student?.meripehchan_id,
                  aadhar_token: userdata?.student?.aadhar_token,
                  student_id: userdata?.student?.student_id,
                  username: userdata?.student?.username,
                },
                'StudentV2',
                osid,
              );
              if (sb_rc_response_text?.error) {
                return response.status(400).send({
                  success: false,
                  status: 'sb_rc_update_error',
                  message: 'Sunbird RC Student Update Failed',
                  result: sb_rc_response_text?.error,
                });
              } else if (sb_rc_response_text?.params?.status === 'SUCCESSFUL') {
                //update detail in student detail
                //find if student private detaile
                const filter = {
                  filters: {
                    student_id: {
                      eq: osid,
                    },
                  },
                };
                const sb_rc_search_detail = await this.searchEntity(
                  'StudentDetailV2',
                  filter,
                );
                //console.log(sb_rc_search_detail);
                if (sb_rc_search_detail?.error) {
                  return response.status(501).send({
                    success: false,
                    status: 'sb_rc_search_error',
                    message: 'Sunbird RC User Search Failed',
                    result: sb_rc_search_detail?.error,
                  });
                } else if (sb_rc_search_detail.length === 0) {
                  // no student found then register
                  return response.status(501).send({
                    success: false,
                    status: 'sb_rc_search_no_found',
                    message: 'Sunbird RC User No Found',
                    result: sb_rc_search_detail?.error,
                  });
                } else {
                  //get student detail os id and update
                  //update value found id
                  const osid = sb_rc_search_detail[0]?.osid;
                  // sunbird registery student
                  let sb_rc_response_text = await this.sbrcUpdate(
                    {
                      acdemic_year: userdata?.studentdetail?.acdemic_year,
                      school_name: userdata?.studentdetail?.school_name,
                      school_udise: userdata?.studentdetail?.school_udise,
                      gaurdian_name: userdata?.studentdetail?.gaurdian_name,
                      mobile: userdata?.studentdetail?.mobile,
                      grade: userdata?.studentdetail?.grade,
                    },
                    'StudentDetailV2',
                    osid,
                  );
                  if (sb_rc_response_text?.error) {
                    return response.status(400).send({
                      success: false,
                      status: 'sb_rc_update_error',
                      message: 'Sunbird RC Student Update Failed',
                      result: sb_rc_response_text?.error,
                    });
                  } else if (
                    sb_rc_response_text?.params?.status === 'SUCCESSFUL'
                  ) {
                  } else {
                    return response.status(400).send({
                      success: false,
                      status: 'sb_rc_update_error',
                      message: 'Sunbird RC Student Update Failed',
                      result: sb_rc_response_text,
                    });
                  }
                }
              } else {
                return response.status(400).send({
                  success: false,
                  status: 'sb_rc_update_error',
                  message: 'Sunbird RC Student Update Failed',
                  result: sb_rc_response_text,
                });
              }
            }
          }
          //portal registration teacher and school
          else {
            // sunbird registery teacher
            //get teacher did
            const issuerRes = await this.generateDid(
              userdata?.teacher?.meripehchanLoginId,
            );
            if (issuerRes?.error) {
              return response.status(400).send({
                success: false,
                status: 'did_generate_error_teacher',
                message: 'DID Generate Failed for Teacher. Try Again.',
                result: issuerRes?.error,
              });
            } else {
              var did = issuerRes[0].verificationMethod[0].controller;
              userdata.teacher.did = did;
              userdata.teacher.username = auto_username;
              let sb_rc_response_text = await this.sbrcInvite(
                userdata.teacher,
                'TeacherV1',
              );
              if (sb_rc_response_text?.error) {
                return response.status(400).send({
                  success: false,
                  status: 'sb_rc_register_error',
                  message: 'Sunbird RC Teacher Registration Failed',
                  result: sb_rc_response_text?.error,
                });
              } else if (sb_rc_response_text?.params?.status === 'SUCCESSFUL') {
                // sunbird registery school
                //get school did
                const issuerRes = await this.generateDid(
                  userdata?.school?.udiseCode,
                );
                if (issuerRes?.error) {
                  return response.status(400).send({
                    success: false,
                    status: 'did_generate_error_school',
                    message: 'DID Generate Failed for School. Try Again.',
                    result: issuerRes?.error,
                  });
                } else {
                  var did = issuerRes[0].verificationMethod[0].controller;
                  userdata.school.did = did;
                  let sb_rc_response_text = await this.sbrcInvite(
                    userdata.school,
                    'SchoolDetail',
                  );
                  if (sb_rc_response_text?.error) {
                    return response.status(400).send({
                      success: false,
                      status: 'sb_rc_register_error',
                      message: 'Sunbird RC SchoolDetail Registration Failed',
                      result: sb_rc_response_text?.error,
                    });
                  } else if (
                    sb_rc_response_text?.params?.status === 'SUCCESSFUL'
                  ) {
                  } else {
                    return response.status(400).send({
                      success: false,
                      status: 'sb_rc_register_duplicate',
                      message: 'SchoolDetail Already Registered in Sunbird RC',
                      result: sb_rc_response_text,
                    });
                  }
                }
              } else {
                return response.status(400).send({
                  success: false,
                  status: 'sb_rc_register_duplicate',
                  message: 'Teacher Already Registered in Sunbird RC',
                  result: sb_rc_response_text,
                });
              }
            }
          }
          //login and get token
          const userToken = await this.getKeycloakToken(
            auto_username,
            auto_password,
          );
          if (userToken?.error) {
            return response.status(501).send({
              success: false,
              status: 'keycloak_invalid_credentials',
              message: userToken?.error, //.message,
              result: null,
            });
          } else {
            return response.status(200).send({
              success: true,
              status: 'digilocker_login_success',
              message: 'Digilocker Login Success',
              user: 'FOUND',
              userData: userdata,
              token: userToken?.access_token,
            });
          }
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received All Parameters.',
        result: null,
      });
    }
  }

  async getStudentDetail(requestbody, response: Response) {
    console.log('456');
    let studentDetails = await this.studentDetails(requestbody);
    console.log('studentDetails', studentDetails);
    if (studentDetails) {
      return response.status(200).send({
        success: true,
        status: 'Success',
        message: 'Student details fetched successfully!',
        result: studentDetails,
      });
    } else {
      return response.status(200).send({
        success: false,
        status: 'Success',
        message: 'Unable to fetch student details!',
        result: null,
      });
    }
  }
  //digilockerAuthorize
  async udiseVerify(udiseid: string, response: Response) {
    //console.log(request);
    response.status(200).send({
      udiseCode: udiseid,
      schoolName: 'SWAMI DYALANANDA J.B SCHOOL ' + udiseid,
      schoolCategory: 1,
      schoolManagementCenter: 1,
      schoolManagementState: 11,
      schoolType: 3,
      classFrom: 1,
      classTo: 5,
      stateCode: '16',
      stateName: 'Tripura',
      districtName: 'WEST TRIPURA',
      blockName: 'AGARTALA MUNICIPAL COORPORATION',
      locationType: 2,
      headOfSchoolMobile: '89******42',
      respondentMobile: '88******96',
      alternateMobile: '',
      schoolEmail: '',
    });
  }

  //getSchoolList
  async getSchoolList(response: Response) {
    //console.log('hi');
    response.status(200).send(schoolList);
  }
  //getSchoolListUdise
  async getSchoolListUdise(udise, response: Response) {
    //console.log('hi');
    let obj = schoolList.find((o) => o.udiseCode === udise);
    if (obj) {
      response.status(200).send({ success: true, status: 'found', data: obj });
    } else {
      response.status(400).send({ success: false, status: 'no_found' });
    }
  }

  //studentBulkRegister
  async studentBulkRegister(
    token: string,
    requestbody: any,
    response: Response,
  ) {
    if (token) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_token_bad_request',
          message: 'Unauthorized',
          result: null,
        });
      } else if (!studentUsername?.preferred_username) {
        return response.status(400).send({
          success: false,
          status: 'keycloak_token_error',
          message: 'Keycloak Token Expired',
          result: null,
        });
      } else {
        //get common detail
        let grade = requestbody?.schoolDetails?.grade;
        let school_udise = requestbody?.schoolDetails?.schoolUdise;
        let school_name = requestbody?.schoolDetails?.school_name;
        let acdemic_year = requestbody?.schoolDetails?.['academic-year'];
        let school_type = requestbody?.schoolDetails?.school_type;
        const studentDetails = requestbody?.studentDetails;
        let iserror = false;
        let errorlist = [];
        if (studentDetails) {
          for (let i = 0; i < studentDetails.length; i++) {
            try {
              const student = studentDetails[i];
              //check student account present in system or not
              const username_name = student?.studentName.split(' ')[0];
              let auto_username = username_name + '@' + student?.dob;
              auto_username = auto_username.toLowerCase();
              //find if student account present in sb rc or not
              const sb_rc_search = await this.sbrcStudentSearch(
                student?.studentName,
                student?.dob,
              );
              //console.log(sb_rc_search);
              if (sb_rc_search?.error) {
                iserror = true;
                errorlist.push(sb_rc_search?.error);
              } else if (sb_rc_search.length === 0) {
                //register student in sb rc
                // sunbird registery student
                let didRes = await this.generateDid(student?.student_id);
                let didGenerate = '';
                if (didRes) {
                  didGenerate = didRes[0].verificationMethod[0].controller;
                }

                let reference_id = 'ULP_' + student?.student_id;
                let sb_rc_response_text = await this.sbrcInvite(
                  {
                    student_id: student?.student_id,
                    DID: didGenerate,
                    reference_id: reference_id,
                    aadhar_token: student?.aadhar_token,
                    student_name: student?.studentName,
                    dob: student?.dob,
                    school_type: school_type,
                    meripehchan_id: '',
                    username: auto_username,
                  },
                  'StudentV2',
                );
                if (sb_rc_response_text?.error) {
                  iserror = true;
                  errorlist.push(sb_rc_response_text?.error);
                } else if (
                  sb_rc_response_text?.params?.status === 'SUCCESSFUL'
                ) {
                  //find osid of student and add detail in student details
                  // sunbird registery student detail
                  let os_student_id =
                    sb_rc_response_text?.result?.StudentV2?.osid;
                  let claim_status = 'approved';
                  let sb_rc_response_text_detail = await this.sbrcInvite(
                    {
                      student_detail_id: '',
                      student_id: os_student_id,
                      mobile: student?.mobile,
                      gaurdian_name: student?.gaurdian_name,
                      school_udise: school_udise,
                      school_name: school_name,
                      grade: grade,
                      acdemic_year: acdemic_year,
                      start_date: '',
                      end_date: '',
                      claim_status: claim_status,
                    },
                    'StudentDetailV2',
                  );
                  if (sb_rc_response_text_detail?.error) {
                    return response.status(400).send({
                      success: false,
                      status: 'sb_rc_register_error',
                      message: 'Sunbird RC Student Registration Failed',
                      result: sb_rc_response_text_detail?.error,
                    });
                  }
                }
              }
            } catch (e) {
              iserror = true;
              errorlist.push(e);
            }
          }
        }
        if (iserror) {
          return response.status(400).send({
            success: false,
            status: 'student_register_bulk_api_error',
            message: 'Student Register Bulk API Error',
            result: errorlist,
          });
        } else {
          return response.status(200).send({
            success: true,
            status: 'student_register_bulk_api_success',
            message: 'Student Register Bulk API Success',
            result: null,
          });
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received token.',
        result: null,
      });
    }
  }

  //studentList
  async studentList(
    token: string,
    grade: string,
    acdemic_year: string,
    response: Response,
  ) {
    if (token && grade && acdemic_year) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_token_bad_request',
          message: 'Unauthorized',
          result: null,
        });
      } else if (!studentUsername?.preferred_username) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_token_error',
          message: 'Keycloak Token Expired',
          result: null,
        });
      } else {
        const sb_rc_search = await this.searchEntity('TeacherV1', {
          filters: {
            username: {
              eq: studentUsername?.preferred_username,
            },
          },
        });
        if (sb_rc_search?.error) {
          return response.status(501).send({
            success: false,
            status: 'sb_rc_search_error',
            message: 'Sunbird RC Teacher Search Failed',
            result: sb_rc_search?.error,
          });
        } else if (sb_rc_search.length === 0) {
          return response.status(404).send({
            success: false,
            status: 'sb_rc_no_did_found',
            message: 'Teacher not Found in Sunbird RC',
            result: null,
          });
        } else {
          let schoolUdise = sb_rc_search[0]?.schoolUdise;
          const sb_rc_search_student_detail = await this.searchEntity(
            'StudentDetailV2',
            {
              filters: {
                school_udise: {
                  eq: schoolUdise,
                },
                grade: {
                  eq: grade,
                },
                acdemic_year: {
                  eq: acdemic_year,
                },
                claim_status: {
                  eq: 'approved',
                },
              },
            },
          );
          if (sb_rc_search_student_detail?.error) {
            return response.status(501).send({
              success: false,
              status: 'sb_rc_search_error',
              message: 'Sunbird RC Student Search Failed',
              result: sb_rc_search_student_detail?.error,
            });
          } else if (sb_rc_search_student_detail.length === 0) {
            return response.status(404).send({
              success: false,
              status: 'sb_rc_no_found',
              message: 'Student not Found in Sunbird RC',
              result: null,
            });
          } else {
            let student_list = [];
            for (let i = 0; i < sb_rc_search_student_detail.length; i++) {
              const sb_rc_search_student = await this.searchEntity(
                'StudentV2',
                {
                  filters: {
                    osid: {
                      eq: sb_rc_search_student_detail[i].student_id,
                    },
                  },
                },
              );
              if (sb_rc_search_student?.error) {
              } else if (sb_rc_search_student.length !== 0) {
                student_list.push({
                  student: sb_rc_search_student[0],
                  studentdetail: sb_rc_search_student_detail[i],
                });
              }
            }
            return response.status(200).send({
              success: true,
              status: 'sb_rc_found',
              message: 'Student Found in Sunbird RC',
              result: student_list,
            });
          }
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received token or request body.',
        result: null,
      });
    }
  }

  //studentBulkCredentials
  async studentBulkCredentials(
    token: string,
    requestbody: any,
    response: Response,
  ) {
    if (token) {
      const studentUsername = await this.verifyStudentToken(token);
      if (studentUsername?.error) {
        return response.status(401).send({
          success: false,
          status: 'keycloak_token_bad_request',
          message: 'Unauthorized',
          result: null,
        });
      } else if (!studentUsername?.preferred_username) {
        return response.status(400).send({
          success: false,
          status: 'keycloak_token_error',
          message: 'Keycloak Token Expired',
          result: null,
        });
      } else {
        //get common detail
        //credentialSubjectCommon
        let grade = requestbody?.credentialSubjectCommon?.grade;
        let academicYear = requestbody?.credentialSubjectCommon?.academicYear;
        //issuerDetail
        let did = requestbody?.issuerDetail?.did;
        let schoolName = requestbody?.issuerDetail?.schoolName;
        let schemaId = requestbody?.issuerDetail?.schemaId;
        //generate schema
        var schemaRes = await this.generateSchema(schemaId);
        const credentialSubject = requestbody?.credentialSubject;
        let iserror = false;
        let errorlist = [];
        if (credentialSubject) {
          for (let i = 0; i < credentialSubject.length; i++) {
            try {
              const credentialSubjectItem = credentialSubject[i];
              let id = credentialSubjectItem?.id;
              let enrolledOn = credentialSubjectItem?.enrolledOn;
              let studentName = credentialSubjectItem?.studentName;
              let guardianName = credentialSubjectItem?.guardianName;
              let issuanceDate = credentialSubjectItem?.issuanceDate;
              let expirationDate = credentialSubjectItem?.expirationDate;
              //issueCredentials obj
              let obj = {
                issuerId: did,
                credSchema: schemaRes,
                credentialSubject: {
                  id: id,
                  enrolledOn: enrolledOn,
                  studentName: studentName,
                  guardianName: guardianName,
                  grade: grade,
                  schoolName: schoolName,
                  academicYear: academicYear,
                },
                issuanceDate: issuanceDate,
                expirationDate: expirationDate,
              };
              //console.log('obj', obj);
              const cred = await this.issueCredentials(obj);
              if (cred?.error) {
                iserror = true;
                errorlist.push(cred?.error);
              }
            } catch (e) {
              iserror = true;
              errorlist.push(e);
            }
          }
        }
        if (iserror) {
          return response.status(400).send({
            success: false,
            status: 'student_cred_bulk_api_error',
            message: 'Student Cred Bulk API Error',
            result: errorlist,
          });
        } else {
          return response.status(200).send({
            success: true,
            status: 'student_cred_bulk_api_success',
            message: 'Student Cred Bulk API Success',
            result: null,
          });
        }
      }
    } else {
      return response.status(400).send({
        success: false,
        status: 'invalid_request',
        message: 'Invalid Request. Not received token.',
        result: null,
      });
    }
  }

  //helper function
  //get convert date and repalce character from string
  async convertDate(datetime) {
    if (!datetime) {
      return '';
    }
    let date_string = datetime.substring(0, 10);
    const datetest = this.moment(date_string, 'DD/MM/YYYY').format(
      'DD/MM/YYYY',
    );
    return datetest;
  }
  async replaceChar(replaceString, found, replace) {
    if (!replaceString) {
      return '';
    }
    const search = found;
    const replaceWith = replace;
    const result = replaceString.split(search).join(replaceWith);
    return result;
  }
  //get jwt token information
  async parseJwt(token) {
    if (!token) {
      return [];
    }
    const decoded = jwt_decode(token);
    return [decoded];
  }

  //get client token
  async getClientToken() {
    let data = this.qs.stringify({
      grant_type: this.keycloakCred.grant_type,
      client_id: this.keycloakCred.client_id,
      client_secret: this.keycloakCred.client_secret,
    });
    let config = {
      method: 'post',
      url:
        process.env.KEYCLOAK_URL +
        'realms/' +
        process.env.REALM_ID +
        '/protocol/openid-connect/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      data: data,
    };

    let response_text = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        response_text = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        response_text = { error: error };
      });
    return response_text;
  }

  //get keycloak token after login
  async getKeycloakToken(username: string, password: string) {
    let data = this.qs.stringify({
      client_id: this.keycloakCred.client_id,
      username: username.toString(),
      password: password,
      grant_type: 'password',
      client_secret: this.keycloakCred.client_secret,
    });

    let config = {
      method: 'post',
      url:
        process.env.KEYCLOAK_URL +
        'realms/' +
        process.env.REALM_ID +
        '/protocol/openid-connect/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      data: data,
    };

    var response_text = null;
    await axios(config)
      .then(function (response) {
        //console.log("data 516", JSON.stringify(response.data));
        response_text = response.data;
      })
      .catch(function (error) {
        console.log('error 520', error);
        response_text = { error: error };
      });

    return response_text;
  }

  //generate did
  async generateDid(studentId: string) {
    let data = JSON.stringify({
      content: [
        {
          alsoKnownAs: [`did.${studentId}`],
          services: [
            {
              id: 'IdentityHub',
              type: 'IdentityHub',
              serviceEndpoint: {
                '@context': 'schema.identity.foundation/hub',
                '@type': 'UserServiceEndpoint',
                instance: ['did:test:hub.id'],
              },
            },
          ],
        },
      ],
    });

    let config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: `${process.env.DID_URL}/did/generate`,
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let response_text = null;
    try {
      const response = await axios(config);
      //console.log("response did", response.data)
      response_text = response.data;
    } catch (error) {
      //console.log('error did', error);
      response_text = { error: error };
    }
    return response_text;
  }

  //search entity meripehchan
  async searchDigiEntity(entity: string, filter: any) {
    let data = JSON.stringify(filter);

    let url = process.env.REGISTRY_URL + 'api/v1/' + entity + '/search';
    //console.log(data + ' ' + url);
    let config = {
      method: 'post',
      url: url,
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let sb_rc_search = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_search = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_search = { error: error };
      });
    return sb_rc_search;
  }

  //search student
  async searchStudent(studentId: string) {
    let data = JSON.stringify({
      filters: {
        studentSchoolID: {
          eq: studentId,
        },
      },
    });

    let config = {
      method: 'post',
      url: process.env.REGISTRY_URL + 'api/v1/StudentDetail/search',
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let sb_rc_search = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_search = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_search = { error: error };
      });
    return sb_rc_search;
  }

  //search student
  async sbrcStudentSearch(studentName: string, dob: string) {
    let data = JSON.stringify({
      filters: {
        student_name: {
          eq: studentName,
        },
        dob: {
          eq: dob,
        },
      },
    });
    //console.log(data);
    let config = {
      method: 'post',
      url: process.env.REGISTRY_URL + 'api/v1/StudentV2/search',
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let sb_rc_search = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_search = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_search = { error: error };
      });
    return sb_rc_search;
  }

  //search entity username
  async searchUsernameEntity(entity: string, searchkey: string) {
    let data = JSON.stringify({
      filters: {
        username: {
          eq: searchkey.toString(),
        },
      },
    });

    let url = process.env.REGISTRY_URL + 'api/v1/' + entity + '/search';
    //console.log(data + ' ' + url);
    let config = {
      method: 'post',
      url: url,
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let sb_rc_search = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_search = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_search = { error: error };
      });
    return sb_rc_search;
  }

  //searchEntity
  async searchEntity(entity: string, filter: any) {
    let data = JSON.stringify(filter);

    let url = process.env.REGISTRY_URL + 'api/v1/' + entity + '/search';
    //console.log(data + ' ' + url);
    let config = {
      method: 'post',
      url: url,
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let sb_rc_search = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_search = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_search = { error: error };
      });
    return sb_rc_search;
  }

  //search entity udise
  async searchUdiseEntity(entity: string, searchkey: string) {
    let data = JSON.stringify({
      filters: {
        udiseCode: {
          eq: searchkey.toString(),
        },
      },
    });

    let url = process.env.REGISTRY_URL + 'api/v1/' + entity + '/search';
    console.log(data + ' ' + url);
    let config = {
      method: 'post',
      url: url,
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let sb_rc_search = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_search = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_search = { error: error };
      });
    return sb_rc_search;
  }

  //verify student token
  async verifyStudentToken(token: string) {
    let config = {
      method: 'get',
      url:
        process.env.KEYCLOAK_URL +
        'realms/' +
        process.env.REALM_ID +
        '/protocol/openid-connect/userinfo',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Authorization: 'Bearer ' + token,
      },
    };

    let response_text = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        response_text = response?.data;
      })
      .catch(function (error) {
        //console.log(error);
        response_text = { error: error };
      });

    return response_text;
  }

  // register student keycloak
  async registerStudentKeycloak(user, clientToken) {
    let data = JSON.stringify({
      enabled: 'true',
      username: user.studentId,
      credentials: [
        {
          type: 'password',
          value: '1234',
          temporary: false,
        },
      ],
    });

    let config = {
      method: 'post',
      url:
        process.env.KEYCLOAK_URL +
        'admin/realms/' +
        process.env.REALM_ID +
        '/users',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer ' + clientToken?.access_token,
      },
      data: data,
    };
    var response_text = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        response_text = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        response_text = { error: error };
      });

    return response_text;
  }

  // sbrc registery
  async sbrcRegistery(did, user) {
    let data = JSON.stringify({
      did: did,
      aadhaarID: user.aadhaarId,
      studentName: user.studentName,
      schoolName: user.schoolName,
      schoolID: user.schoolId,
      studentSchoolID: user.studentId,
      phoneNo: user.phoneNo,
    });

    let config_sb_rc = {
      method: 'post',
      url: process.env.REGISTRY_URL + 'api/v1/StudentDetail/invite',
      headers: {
        'content-type': 'application/json',
      },
      data: data,
    };

    var sb_rc_response_text = null;
    await axios(config_sb_rc)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_response_text = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_response_text = { error: error };
      });

    return sb_rc_response_text;
  }

  // register user in keycloak
  async registerUserKeycloak(username, password, clientToken) {
    let data = JSON.stringify({
      enabled: 'true',
      username: username,
      credentials: [
        {
          type: 'password',
          value: password,
          temporary: false,
        },
      ],
    });

    let config = {
      method: 'post',
      url:
        process.env.KEYCLOAK_URL +
        'admin/realms/' +
        process.env.REALM_ID +
        '/users',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer ' + clientToken?.access_token,
      },
      data: data,
    };
    var response_text = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        response_text = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        response_text = { error: error };
      });

    return response_text;
  }

  // invite entity in registery
  async sbrcInvite(inviteSchema, entityName) {
    let data = JSON.stringify(inviteSchema);

    let config_sb_rc = {
      method: 'post',
      url: process.env.REGISTRY_URL + 'api/v1/' + entityName + '/invite',
      headers: {
        'content-type': 'application/json',
      },
      data: data,
    };

    var sb_rc_response_text = null;
    await axios(config_sb_rc)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_response_text = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_response_text = { error: error };
      });

    return sb_rc_response_text;
  }

  // invite entity in registery
  async sbrcUpdate(updateSchema, entityName, osid) {
    let data = JSON.stringify(updateSchema);

    let config_sb_rc = {
      method: 'put',
      url: process.env.REGISTRY_URL + 'api/v1/' + entityName + '/' + osid,
      headers: {
        'content-type': 'application/json',
      },
      data: data,
    };

    var sb_rc_response_text = null;
    await axios(config_sb_rc)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        sb_rc_response_text = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        sb_rc_response_text = { error: error };
      });

    return sb_rc_response_text;
  }

  // cred search
  async credSearch(sb_rc_search) {
    console.log('sb_rc_search', sb_rc_search);

    let data = JSON.stringify({
      subject: {
        id: sb_rc_search[0]?.did ? sb_rc_search[0].did : '',
      },
    });
    // let data = JSON.stringify({
    //   subjectId: sb_rc_search[0]?.did ? sb_rc_search[0].did : '',
    // });

    let config = {
      method: 'post',
      url: process.env.CRED_URL + '/credentials/search',
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    let cred_search = null;
    await axios(config)
      .then(function (response) {
        //console.log(JSON.stringify(response.data));
        cred_search = response.data;
      })
      .catch(function (error) {
        //console.log(error);
        cred_search = { error: error };
      });

    return cred_search;
  }

  // student details
  async studentDetails(requestbody) {
    console.log('requestbody', requestbody);
    var data = JSON.stringify(requestbody);

    var config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: `${process.env.REGISTRY_URL}api/v1/StudentDetail/search`,
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };

    try {
      let stdentDetailRes = await axios(config);
      return stdentDetailRes.data;
    } catch (err) {
      console.log('err');
    }
  }

  //generateSchema
  async generateSchema(schemaId) {
    var config = {
      method: 'get',
      maxBodyLength: Infinity,
      url: `${process.env.SCHEMA_URL}/schema/jsonld?id=${schemaId}`,
      headers: {},
    };

    try {
      const response = await axios(config);
      console.log('response schema', response.data);
      return response.data;
    } catch (error) {
      console.log('error schema', error);
    }
  }

  //issueCredentials
  async issueCredentials(payload) {
    var data = JSON.stringify({
      credential: {
        '@context': [
          'https://www.w3.org/2018/credentials/v1',
          'https://www.w3.org/2018/credentials/examples/v1',
        ],
        id: 'did:ulp:b4a191af-d86e-453c-9d0e-dd4771067235',
        type: ['VerifiableCredential', 'UniversityDegreeCredential'],
        issuer: `${payload.issuerId}`,
        issuanceDate: payload.issuanceDate,
        expirationDate: payload.expirationDate,
        credentialSubject: payload.credentialSubject,
        options: {
          created: '2020-04-02T18:48:36Z',
          credentialStatus: {
            type: 'RevocationList2020Status',
          },
        },
      },
      credentialSchemaId: payload.credSchema.id,
      tags: ['tag1', 'tag2', 'tag3'],
    });
    var config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: process.env.CRED_URL + '/credentials/issue',
      headers: {
        'Content-Type': 'application/json',
      },
      data: data,
    };
    try {
      const response = await axios(config);
      //console.log('cred response');
      return response.data;
    } catch (e) {
      //console.log('cred error', e.message);
      return { error: e };
    }
  }
}
